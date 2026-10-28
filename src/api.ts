// The HTTP surface — POST /report (contracts/api_contract.md).
//
// This project owns an HTTP API. It is not a plugin, not a library, and not a
// component of somebody else's application. Two thin callers (the campus AI assistant
// ticketing agent and the ITS help-desk site) post text and render a reply;
// neither parses, decides, or matches, which is why a third caller costs nothing.
//
// This module is deliberately thin: normalize an untrusted request, call the
// orchestrator, choose a status code. It composes no strings — every word comes
// from response_composer.md, and a reply assembled here would be a second,
// unaudited place the service could fabricate.

import type { ReportRequest, ReportResponse } from './contracts/api';
import { handleReport, type OrchestratorDeps } from './orchestrator';

/**
 * The request boundary. Same discipline as the parser's normalize(): the body
 * arrives as `unknown` and every bad shape becomes a clean value rather than a
 * throw, because api_contract.md's seven outcomes are the ENTIRE vocabulary of
 * what comes back — there is no 400 in the contract to fall back on.
 *
 * Two defaults worth naming:
 *  • `canFollowUp` defaults to TRUE on a malformed request. A missing flag must
 *    not silently become "file whatever you have from an empty body" — asking is
 *    the conservative direction and produces no junk ticket.
 *  • a missing `identityRef` collapses to one shared bucket, so unattributable
 *    callers share a throttle budget rather than each getting a fresh one.
 */
export function normalizeRequest(raw: unknown): ReportRequest {
  const r: Record<string, unknown> =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const overrideMatchId = typeof r.overrideMatchId === 'string' ? r.overrideMatchId : '';

  return {
    text: typeof r.text === 'string' ? r.text : '',
    identityRef:
      typeof r.identityRef === 'string' && r.identityRef !== '' ? r.identityRef : 'unattributed-caller',
    canFollowUp: typeof r.canFollowUp === 'boolean' ? r.canFollowUp : true,
    ...(overrideMatchId === '' ? {} : { overrideMatchId }),
  };
}

/**
 * Outcome → HTTP status. The body is the contract; the code is a courtesy to
 * callers' retry logic. Note that every status carries a full ReportResponse —
 * there is no error envelope, no stack trace, and no partial result.
 */
export function statusFor(outcome: ReportResponse['outcome']): number {
  switch (outcome) {
    case 'THROTTLED':
      return 429;
    case 'UNAVAILABLE':
      return 503;
    default:
      return 200;
  }
}

export type HttpResult = { readonly status: number; readonly body: ReportResponse };

/** POST /report. Every code path returns one of the seven outcomes. */
export async function postReport(raw: unknown, deps: OrchestratorDeps): Promise<HttpResult> {
  const body = await handleReport(normalizeRequest(raw), deps);
  return { status: statusFor(body.outcome), body };
}
