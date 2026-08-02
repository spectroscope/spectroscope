// From a session to its trace in Langfuse, without a server round trip
// (card 137).
//
// The trace id is derived, not fetched: OtlpSink stamps every exported span
// with sha256("trace:" + sessionId) truncated to 16 bytes, and the browser
// already holds the session id. So the link is pure arithmetic over one
// string, pinned on both sides of the wire by the same literal.
//
// The endpoint is the OTLP endpoint that was ACTUALLY exported to, taken from
// the otlp_export frame rather than from Settings, because Settings can be
// edited after the fact and the frame cannot.

import { sha256Hex } from "./sha256";

/** The Langfuse OTLP path. Everything before it is the instance root. */
const OTEL_PATH = "/api/public/otel";

/**
 * The trace id a session's spans carry. Mirrors
 * {@code OtlpSink.traceIdFor} byte for byte: 32 lowercase hex characters.
 */
export function langfuseTraceId(sessionId: string): string {
  return sha256Hex(`trace:${sessionId}`).slice(0, 32);
}

/**
 * The Langfuse URL for this session's trace, or null when the configured
 * endpoint is not Langfuse shaped.
 *
 * Returning null is the point of the function. A Jaeger or Phoenix endpoint
 * exports perfectly well and has no page of this shape, so offering a link
 * there would ship a guaranteed 404. Never throws: a malformed endpoint is a
 * reason to show nothing, not to break the trace toolbar.
 */
export function langfuseTraceUrl(otlpEndpoint: string | null | undefined, sessionId: string): string | null {
  if (!otlpEndpoint || !sessionId) return null;
  let url: URL;
  try {
    url = new URL(otlpEndpoint);
  } catch {
    return null;
  }
  // The endpoint may be the bare OTLP path or the /v1/traces form under it,
  // with or without a trailing slash. Anything else is another backend.
  const at = url.pathname.indexOf(OTEL_PATH);
  if (at < 0) return null;
  const rest = url.pathname.slice(at + OTEL_PATH.length);
  if (rest !== "" && rest !== "/" && rest !== "/v1/traces" && rest !== "/v1/traces/") {
    return null;
  }
  const root = url.origin + url.pathname.slice(0, at);
  return `${root}/trace/${langfuseTraceId(sessionId)}`;
}
