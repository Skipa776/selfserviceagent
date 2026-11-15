// chatClient.ts — the OpenAI-compatible text client used by the analyst
// PROPOSAL model (src/analyst/model.ts, analyst/server.ts) and nothing else.
// The report parser moved to the Anthropic SDK (src/parser/llmParser.ts); this
// file stays so the analyst workspace keeps working unchanged.
//
// Deliberately tiny and deliberately dumb: one method, text in, text out. It
// throws on every failure — non-2xx, timeout, malformed envelope, empty
// content. The CALLER decides what a failure means. A client that returned ''
// on error would hide a dead API behind a bad parse. The structural ChatClient
// seam lets tests supply a fake without a network or mocking library.

/** Text in, the assistant's reply out. Throws on any failure. */
export type ChatClient = {
  complete(messages: readonly ChatMessage[]): Promise<string>;
};

export type ChatMessage = { readonly role: 'system' | 'user'; readonly content: string };

/**
 * These are transport hygiene values, not matching or product thresholds. A
 * hung analyst call must fail quickly so the operator page reports it instead
 * of spinning.
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
};

/**
 * A ChatClient over the provider's OpenAI-compatible `/chat/completions`.
 *
 * `fetch` is Node's built-in (24.x), so no provider SDK is required.
 */
export function llmChatClient(config: LlmConfig): ChatClient {
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
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new Error('llm returned no assistant content');
      }
      return content;
    },
  };
}

/** Convenience for the composition root: a live client, or null if unconfigured. */
export function llmClientFromEnv(env: NodeJS.ProcessEnv = process.env): ChatClient | null {
  const config = llmConfigFromEnv(env);
  return config === null ? null : llmChatClient(config);
}
