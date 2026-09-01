// CARD 329 — what a recorded address IS, before the map draws anything from it.
//
// Two events on the wire carry an outbound address and the flow map read
// neither of them: `llm_exchange.url` (the backend the turn went to) and
// `browser_action.url` (the page the browser ended on). Both can arrive as a
// REDACTION MARKER instead of an address — the writer replaces a
// credential-shaped one whole — and the marker travels in two different shapes
// depending on which side wrote it:
//
//   the address form, BrowserWireRecorder.java:427   "[redacted: " + rule + "]"
//   the object form,  BrowserWireRecorder.java:376   {kind,rule,bytes}
//   and HookRunner.java:42 mirrors the address form for a redacted command.
//
// ZERO markers exist anywhere in this machine's store — sessions, both
// archives, all 24 browser sidecars, all 60 llm-wire sidecars — so the shapes
// here come from the WRITER and not from a sample. That is also why they are
// in a module of their own with a test each: an unexercised branch that lives
// inside a render function is a branch nobody can bite.

import { isLoopbackAddress } from "../../state/runDigest";

/** What one recorded address turns out to be. */
export type Hop =
  /** An address that LEFT this machine, as `host` or `host:port`. */
  | { kind: "host"; host: string }
  /** The record deliberately does not say where — a credential shape fired. */
  | { kind: "redacted" }
  /** Nothing outbound: absent, unreadable, or this machine's own loopback. */
  | { kind: "none" };

/**
 * Whether a recorded address is a redaction marker rather than an address.
 *
 * Both writer shapes, because one may be handled and the other missed: the
 * session wire types `url` as a string and carries the bracketed form, while
 * the same idea travels as an object in the sidecar. A tolerant reader that
 * knew only one of them would print the other as "[object Object]" — a
 * rendering bug wearing the costume of a redaction bug.
 *
 * @param url the recorded address, in whatever shape it arrived
 * @return true when it is a marker
 */
export function isRedactionMarker(url: unknown): boolean {
  if (typeof url === "string") return url.startsWith("[redacted:");
  if (typeof url !== "object" || url === null) return false;
  return (url as { kind?: unknown }).kind === "redacted";
}

/**
 * What a recorded address says about leaving this machine.
 *
 * The locality test is `isLoopbackAddress` from runDigest, never a second copy:
 * that function's own doc names `localhost.evil.example` as the reason it
 * matches the host EXACTLY and never by substring, and a sloppier second
 * spelling inside the map is precisely how a remote host would get filed as
 * local — on the one node whose whole job is to say what left.
 *
 * An address that is neither a marker nor a parseable URL yields `none`. That
 * is the conservative direction on purpose: this node may never draw a hop
 * nobody recorded, and half a parse is a claim.
 *
 * @param url the recorded address, in whatever shape it arrived
 * @return the hop
 */
export function outboundHop(url: unknown): Hop {
  if (isRedactionMarker(url)) return { kind: "redacted" };
  const host = parsedHost(url);
  if (host === null || isLoopbackAddress(host)) return { kind: "none" };
  return { kind: "host", host };
}

/**
 * The `host` a recorded address parses to, or null when it is not one.
 *
 * PARSING only, and deliberately no locality: this exists so that
 * {@link modelLocation} can tell "nothing parseable was recorded" apart from
 * "loopback" without spelling the parse — or the loopback rule — a second time.
 * `URL.host` and not `URL.hostname`, so a port stays on the host: it is what a
 * reader needs to find the box again.
 *
 * @param url the recorded address, in whatever shape it arrived
 * @return the host, or null when there is not one
 */
function parsedHost(url: unknown): string | null {
  if (typeof url !== "string" || url === "") return null;
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  return host === "" ? null : host;
}

/** Where the backend that served a run turned out to be (card 333). */
export type ModelLocation =
  /** The address is this machine's own loopback. */
  | { kind: "local" }
  /** The call left this machine, for this host. */
  | { kind: "host"; host: string }
  /** A credential shape fired: the record deliberately does not say where. */
  | { kind: "redacted" }
  /** No address was recorded — 92.6 % of this machine's session files. */
  | { kind: "unknown" };

/**
 * Where the model was, for the one card whose job is to name the model.
 *
 * The card printed the literal word "remote" with nothing deciding it, so it
 * was wrong for every local backend this project tests against. This is the
 * decision that replaces it, and it is a CONSUMER of card 329's classifier —
 * the locality question is answered by {@link outboundHop} and by nothing here.
 *
 * <p>What it adds is the two states `outboundHop` folds together. That fold is
 * right for the network node, which only ever had to decide whether to draw a
 * hop; it is wrong here, because "the loopback backend on this machine" and
 * "no address was recorded" are not the same fact and only one of them may be
 * called local. So the order is: a redaction stays a redaction before any
 * locality question; an address that does not parse is unknown, never local —
 * a provider NAME is not evidence of a place; and only then does `outboundHop`
 * decide, whose remaining `none` can be nothing but loopback.
 *
 * @param url the recorded address, in whatever shape it arrived
 * @return where the backend was, as far as the record says
 */
export function modelLocation(url: unknown): ModelLocation {
  if (isRedactionMarker(url)) return { kind: "redacted" };
  if (parsedHost(url) === null) return { kind: "unknown" };
  const hop = outboundHop(url);
  return hop.kind === "host" ? { kind: "host", host: hop.host } : { kind: "local" };
}

/** The three things a recorded page address can be. */
export type RecordedUrlState = "address" | "redacted" | "absent";

/**
 * Which of the three a recorded address is.
 *
 * They are three states of ONE field and may never collapse into two:
 * `url` is ABSENT on 3 of the 4 real `browser_action` events on this machine —
 * a failed navigate records no page at all — and "absent" is not "empty" and
 * neither of them is "the address was recorded and deliberately withheld".
 *
 * @param url the recorded address, in whatever shape it arrived
 * @return which state it is in
 */
export function recordedUrlState(url: unknown): RecordedUrlState {
  if (isRedactionMarker(url)) return "redacted";
  return typeof url === "string" && url !== "" ? "address" : "absent";
}

/**
 * The redaction rule that fired, when the marker names one.
 *
 * @param url the recorded address, in whatever shape it arrived
 * @return the rule, or "" when the marker does not say
 */
export function redactionRule(url: unknown): string {
  if (typeof url === "string") return /^\[redacted: ([^\]]*)\]$/.exec(url)?.[1] ?? "";
  if (typeof url !== "object" || url === null) return "";
  const rule = (url as { rule?: unknown }).rule;
  return typeof rule === "string" ? rule : "";
}
