// chatClient.ts — the ONLY file in this repo that opens a socket.
//
// Deliberately tiny and deliberately dumb: one method, text in, text out. It
// knows the LLM provider API's wire format and nothing about ProblemReport, the
// catalog, JSON schemas, or repair. llmParser.ts owns all of that and is tested
// against recorded strings, which is only possible because the transport is
// this thin.
//
// It throws on every failure — non-2xx, timeout, malformed envelope, empty
// content. That is the contract: the CALLER decides what a failure means, and
// error_rescue_map.md says what it means (keyword fallback, never UNAVAILABLE).
// A client that returned '' on error would hide a dead API behind a bad parse.
// The structural ChatClient seam lets tests supply a fake without a network or
// mocking library.

/** Text in, the assistant's reply out. Throws on any failure. */
export type ChatClient = {
  complete(messages: readonly ChatMessage[]): Promise<string>;
  usage?(): ChatUsage;
};

export type ChatUsage = {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
};

export type TokenCountResult = {
  readonly totalTokens: number;
  readonly modelUsed: string;
  readonly tokenizerType: string;
};

export type ChatMessage = { readonly role: 'system' | 'user'; readonly content: string };

/**
 * These are transport hygiene values, not matching or product thresholds. The
 * timeout matters for a reason the number does not: a hung parse must become a
 * keyword parse quickly, because the user is waiting and a slow honest answer is
 * still an answer (error_rescue_map.md `llm_unavailable`).
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const TEMPERATURE = 0; // structured extraction, not writing — nothing to be creative about

function supportsTemperature(model: string): boolean {
  return !/^gpt-5\.6(?:-|$)/.test(model);
}

export type LlmConfig = {
  readonly url: string;
  readonly key: string;
  readonly model: string;
  readonly timeoutMs: number;
};

/**
 * Read the three env names, or return null if any is missing.
 *
 * NULL, NOT A THROW. An unconfigured environment is the stage-1 condition and
 * must stay bootable — `buildStage2()` treats null as "no LLM available" and
 * wires the keyword parser, so a clone with no `.env` still runs the demo. If
 * this threw, an absent key would be a crash at startup instead of a documented
 * degraded mode. A clean checkout must remain usable without credentials.
 *
 * No value here is hardcoded and none is committed: `.env.example` lists the
 * names and holds none of them.
 */
export function llmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const url = env.LLM_API_URL?.trim();
  const key = env.LLM_API_KEY?.trim();
  const model = env.LLM_MODEL?.trim();
  if (!url || !key || !model) return null;

  const parsedTimeout = Number(env.LLM_TIMEOUT_MS);
  return {
    url: url.replace(/\/+$/, ''),
    key,
    model,
    timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS,
  };
}

/** The OpenAI-compatible `/chat/completions` envelope, as far as we read it. */
type ChatCompletionResponse = {
  choices?: { message?: { content?: unknown } }[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
};

/**
 * A ChatClient over the provider's OpenAI-compatible `/chat/completions`.
 *
 * `fetch` is Node's built-in (24.x), so no provider SDK is required.
 */
export function llmChatClient(config: LlmConfig): ChatClient {
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  return {
    async complete(messages) {
      const res = await fetch(`${config.url}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.key}`,
        },
        body: JSON.stringify({
          model: config.model,
          ...(supportsTemperature(config.model) ? { temperature: TEMPERATURE } : {}),
          messages,
        }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (!res.ok) {
        // Status only. The body of a 401 can echo request headers, and this
        // message reaches the audit log — boundaries.md forbids a credential
        // anywhere but the request itself.
        throw new Error(`llm http ${res.status}`);
      }

      // The response is untrusted input too, exactly like the model's text.
      // A provider that changes its envelope must produce a keyword fallback,
      // not a TypeError three frames away.
      const body = (await res.json()) as ChatCompletionResponse;
      const promptTokens = Number(body.usage?.prompt_tokens);
      const completionTokens = Number(body.usage?.completion_tokens);
      const totalTokens = Number(body.usage?.total_tokens);
      if (Number.isFinite(promptTokens)) usage.promptTokens += promptTokens;
      if (Number.isFinite(completionTokens)) usage.completionTokens += completionTokens;
      if (Number.isFinite(totalTokens)) usage.totalTokens += totalTokens;
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new Error('llm returned no assistant content');
      }
      return content;
    },
    usage: () => ({ ...usage }),
  };
}

/** Convenience for the composition root: a live client, or null if unconfigured. */
export function llmClientFromEnv(env: NodeJS.ProcessEnv = process.env): ChatClient | null {
  const config = llmConfigFromEnv(env);
  return config === null ? null : llmChatClient(config);
}

/** Uses the provider's documented tokenizer endpoint without generating a completion. */
export async function countLlmTokens(
  config: LlmConfig,
  messages: readonly ChatMessage[],
): Promise<TokenCountResult> {
  const endpoint = `${new URL(config.url).origin}/utils/token_counter`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.key}`,
    },
    body: JSON.stringify({ model: config.model, messages }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`llm token counter http ${response.status}`);
  const body = await response.json() as {
    total_tokens?: unknown;
    model_used?: unknown;
    tokenizer_type?: unknown;
    error?: unknown;
  };
  if (body.error === true || !Number.isFinite(Number(body.total_tokens))) {
    throw new Error('llm token counter returned no count');
  }
  return {
    totalTokens: Number(body.total_tokens),
    modelUsed: typeof body.model_used === 'string' ? body.model_used : config.model,
    tokenizerType: typeof body.tokenizer_type === 'string' ? body.tokenizer_type : 'unknown',
  };
}
