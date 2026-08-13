// The net fence, as the browser's own request hook sees it (cards 199 and 201).
//
// Card 199 put the fence in Java, where it judges the address a tool was HANDED.
// That is an entry check and NetFence's own javadoc says so: once a browser is
// running it follows redirects and executes page JavaScript that can navigate
// anywhere, and none of those requests return through the JVM.
//
// This file is the other half. It runs inside session.webRequest.onBeforeRequest,
// so it fires for the top-level navigation, EVERY redirect hop and every
// subresource, in-process, with no proxy and no second component. That is the
// hole browse_page documents and cannot close, and it is the security argument
// card 200 section 6 makes for this engine.
//
// Two implementations of one policy drift, so both read the same vector table:
// spectro-core/src/main/resources/browser/fence-vectors.json. Where they
// honestly differ — old IPv4 spellings, because Chromium's URL parser and Java's
// InetAddress read them differently — the table carries a divergence register
// and both sides assert their own column.
//
// This half used to stop at address LITERALS, on the argument that the hook is
// synchronous and a resolver call per subresource is a round trip on the page's
// critical path. A review measured what that cost on 2026-08-13: with
// allowLocalhost off, a 302 to a public NAME that resolves to loopback loaded
// fine and nothing was refused. Java catches that at the entry; nothing caught
// it on a hop, which is the one thing this half exists for.
//
// So the hook resolves too. onBeforeRequest may answer asynchronously — that is
// how proxy and auth flows are written — and the answers are cached for a short
// window, so a page with fifty subresources on four hosts pays four lookups.
// What remains, stated rather than discovered: a record whose answer CHANGES
// between the fence's lookup and Chromium's own (DNS rebinding) is not caught by
// either half, because neither is the one that dials. That is written down in
// docs/BROWSER.md and said in the UI, not only here.

/** Whether the local verify loop is opted in. The one thing an operator decides. */
export interface FencePolicy {
  /** Card 199's opt-in: loopback stays refused without it, and it never widens. */
  allowLocalhost: boolean;
}

/** One refusal: what was refused, which rule did it, and the sentence a human reads. */
export interface FenceRefusal {
  /** The host and port that were refused — never a path, a query or userinfo. */
  address: string;
  /** The rule's stable name, the same vocabulary the Java fence uses. */
  rule: string;
  /** The operator-facing and model-facing sentence. */
  sentence: string;
}

/** RFC 1918, the CGNAT block a tailnet uses, and link-local — as the hook sees them. */
const PRIVATE_V4: [RegExp, string][] = [
  [/^10\./, "rfc1918"],
  [/^172\.(1[6-9]|2\d|3[01])\./, "rfc1918"],
  [/^192\.168\./, "rfc1918"],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, "cgnat-tailnet"],
  [/^169\.254\./, "link-local"],
];

/** Why each rule refuses, in the operator's words. Same wording as the Java side. */
const WHY: Record<string, string> = {
  "file-url": "this tool reaches the network, not the local disk",
  "non-http-scheme": "only http and https are reachable",
  loopback:
    "it is this machine, and the local verify loop is not opted in " +
    "(set allowLocalhost in the settings to reach it on purpose)",
  rfc1918: "it is a private network address, RFC 1918",
  "cgnat-tailnet": "it is in 100.64/10, the range a tailnet uses",
  "link-local": "it is a link-local address",
  "unique-local": "it is a unique-local address",
  unspecified: "it is the unspecified address",
  multicast: "it is a multicast address, which means every host on the segment",
  broadcast: "it is the broadcast address",
  unparsable: "it is not a readable http address",
};

/**
 * The one shape a refusal takes: what, why, and the rule's own name.
 *
 * @param address the host and port, never a path, a query or userinfo
 * @param rule    the rule's stable name
 * @param also    one extra clause, for a spelling a reader would not recognise
 */
function refusal(address: string, rule: string, also = ""): FenceRefusal {
  return {
    address,
    rule,
    sentence: `refused ${address}: ${also}${WHY[rule] ?? "the net fence refuses it"} `
      + `(rule: ${rule}).`,
  };
}

/** "localhost" and anything under it, decided before any address parsing. */
function isLoopbackName(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost");
}

/**
 * An IPv6 literal as its sixteen bytes, or null when it is not one.
 *
 * Written out rather than matched with a prefix regex because a regex on the
 * TEXT reads a spelling, and the fence has to judge an ADDRESS. That was the
 * measured defect: `ruleForV6` tested `::1`, `fe8`, `fc`, `ff` and had no
 * `::ffff:` case, so `[::ffff:192.168.1.1]` — which every stack treats as
 * 192.168.1.1 — fell through to allowed, and a 302 to it reached the LAN with
 * zero refusals while the plain literal was blocked.
 */
function bytesForV6(literal: string): number[] | null {
  let text = literal.toLowerCase();
  if (text.includes("%")) {
    text = text.slice(0, text.indexOf("%"));   // a zone id addresses no differently
  }
  // A trailing dotted quad ("::ffff:192.168.1.1") is two more groups.
  const dotted = /^(.*:)((\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}))$/.exec(text);
  let tail: number[] = [];
  if (dotted) {
    const quad = [dotted[3], dotted[4], dotted[5], dotted[6]].map(Number);
    if (quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    tail = quad;
    text = dotted[1].slice(0, -1);   // drop the colon that joined them
    if (text === "") text = "::";     // "::1.2.3.4" leaves an empty head
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0].split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : halves[1].split(":")) : [];
  const groups = (list: string[]): number[] | null => {
    const out: number[] = [];
    for (const group of list) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const value = parseInt(group, 16);
      out.push((value >> 8) & 0xff, value & 0xff);
    }
    return out;
  };
  const left = groups(head);
  const right = groups(rest);
  if (left === null || right === null) return null;
  const known = left.length + right.length + tail.length;
  if (known > 16) return null;
  if (halves.length === 1) {
    return known === 16 ? [...left, ...tail] : null;
  }
  return [...left, ...new Array(16 - known).fill(0), ...right, ...tail];
}

/** What an IPv6 literal is: the rule it breaks, and the IPv4 address it hides. */
interface V6Verdict {
  rule: string | null;
  /** The dotted IPv4 address underneath, when this is an IPv4-mapped spelling. */
  mapped: string | null;
}

/** The rule an IPv6 literal breaks, and whether it is an IPv4 address in disguise. */
function classifyV6(host: string): V6Verdict {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  const bytes = bytesForV6(bare);
  if (bytes === null) return { rule: null, mapped: null };
  const zeros = bytes.slice(0, 10).every((b) => b === 0);
  if (zeros && bytes.slice(10, 15).every((b) => b === 0) && bytes[15] === 1) {
    return { rule: "loopback", mapped: null };
  }
  if (bytes.every((b) => b === 0)) return { rule: "unspecified", mapped: null };
  // ::ffff:0:0/96 — an IPv4 address wearing an IPv6 spelling. Every stack dials
  // the v4 address underneath, so it is judged as that v4 address.
  if (zeros && bytes[10] === 0xff && bytes[11] === 0xff) {
    const dotted = bytes.slice(12).join(".");
    return { rule: ruleForV4(dotted), mapped: dotted };
  }
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
    return { rule: "link-local", mapped: null };
  }
  if ((bytes[0] & 0xfe) === 0xfc) return { rule: "unique-local", mapped: null };
  if (bytes[0] === 0xff) return { rule: "multicast", mapped: null };
  return { rule: null, mapped: null };
}

/** The rule an IPv6 literal breaks, or null. */
function ruleForV6(host: string): string | null {
  return classifyV6(host).rule;
}

/** The rule a dotted-quad IPv4 breaks, or null. */
function ruleForV4(host: string): string | null {
  const octets = host.split(".").map((n) => Number(n));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  if (octets[0] === 127) return "loopback";
  if (octets.every((n) => n === 0)) return "unspecified";
  if (octets.every((n) => n === 255)) return "broadcast";
  if (octets[0] >= 224 && octets[0] <= 239) return "multicast";
  for (const [pattern, rule] of PRIVATE_V4) {
    if (pattern.test(host)) return rule;
  }
  return null;
}

/**
 * Whether this URL is refused. `null` means allowed.
 *
 * The host is read off a WHATWG `URL`, which is Chromium's own parser — so the
 * address judged here is the address the browser will actually dial, including
 * the old IPv4 spellings (`2130706433`, `0x7f000001`, `0177.0.0.1`) that it
 * normalises to loopback and the JDK does not.
 */
export function refuse(rawUrl: string, policy: FencePolicy): FenceRefusal | null {
  if (!rawUrl || !rawUrl.trim()) {
    return refusal("(no address)", "unparsable");
  }
  const trimmed = rawUrl.trim();
  if (trimmed.toLowerCase().startsWith("file:")) {
    return refusal("a file:// URL", "file-url");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // A non-http scheme with no authority still deserves its own rule, because
    // "javascript:" and "data:" are the two a page reaches for first.
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]{0,19}):/.exec(trimmed);
    // An http(s) URL that will not parse is unreadable, not a foreign scheme:
    // "http://" has the right scheme and no host at all.
    if (!scheme || /^https?$/i.test(scheme[1])) {
      return refusal("(unreadable)", "unparsable");
    }
    return refusal(`the scheme "${scheme[1]}"`, "non-http-scheme");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return refusal(`the scheme "${parsed.protocol.replace(/:$/, "")}"`, "non-http-scheme");
  }
  const host = parsed.hostname;
  if (!host) {
    return refusal("(unreadable)", "unparsable");
  }
  // Nothing but the host and the port ever enters a refusal: the URL may carry
  // a token in its path, its query or its userinfo, and a refusal reaches the
  // model and the transcript.
  const where = parsed.port ? `${host.replace(/^\[|\]$/g, "")}:${parsed.port}` : host.replace(/^\[|\]$/g, "");

  if (isLoopbackName(host)) {
    return policy.allowLocalhost ? null : refusal(where, "loopback");
  }
  const verdict = host.startsWith("[")
    ? classifyV6(host)
    : { rule: ruleForV4(host), mapped: null };
  // Chromium normalises [::ffff:192.168.1.1] to [::ffff:c0a8:101], and nobody
  // recognises their own router in that. The address stays what the browser
  // would dial; the sentence adds the spelling a human reads.
  const also = verdict.mapped ? `it is ${verdict.mapped} in an IPv6 spelling, and ` : "";
  if (verdict.rule === "loopback") {
    return policy.allowLocalhost ? null : refusal(where, "loopback", also);
  }
  return verdict.rule === null ? null : refusal(where, verdict.rule, also);
}

/** How a host name becomes addresses. A seam, so the suite answers from a table. */
export type HostLookup = (host: string) => Promise<string[]>;

/** Whether this host is already an answer rather than a question for DNS. */
function isAddressLiteral(host: string): boolean {
  // The WHATWG parser has already normalised every IPv4 spelling it accepts —
  // 2130706433 and 0x7f000001 both arrive as 127.0.0.1 — so what is left is a
  // dotted quad, a bracketed IPv6 literal, or a name.
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/**
 * Whether this URL is refused once its host NAME has been resolved.
 *
 * <p>The literal check runs first and unchanged, so an address is decided
 * without a resolver. Only a name reaches DNS, and then EVERY answer is judged
 * — one private answer refuses the request, which is the same rule the Java
 * entry check applies.
 *
 * <p>A name that does not resolve is left alone: the fence invents no answer,
 * and a request that cannot resolve cannot connect either.
 *
 * @param rawUrl the address the browser is about to dial
 * @param policy the loopback opt-in
 * @param lookup how a name becomes addresses
 */
export async function refuseResolved(
  rawUrl: string,
  policy: FencePolicy,
  lookup: HostLookup,
): Promise<FenceRefusal | null> {
  const literal = refuse(rawUrl, policy);
  if (literal) return literal;
  let host: string;
  let where: string;
  try {
    const parsed = new URL(rawUrl.trim());
    host = parsed.hostname;
    where = parsed.port ? `${host}:${parsed.port}` : host;
  } catch {
    return null;   // refuse() already had its say about anything unparsable
  }
  if (!host || isAddressLiteral(host) || isLoopbackName(host)) {
    return null;
  }
  let answers: string[];
  try {
    answers = await lookup(host);
  } catch {
    return null;
  }
  for (const answer of answers) {
    const rule = answer.includes(":") ? ruleForV6(answer) : ruleForV4(answer);
    if (rule === null || (rule === "loopback" && policy.allowLocalhost)) {
      continue;
    }
    return {
      address: where,
      rule,
      sentence: `refused ${where}: it resolves to ${answer}, and `
        + `${WHY[rule] ?? "the net fence refuses it"} (rule: ${rule}).`,
    };
  }
  return null;
}

/** How long one resolved answer is reused. Short enough to notice a real change. */
export const LOOKUP_TTL_MS = 30_000;

/**
 * The same lookup, answered from memory for a short window.
 *
 * <p>The hook fires for every subresource, so a page with fifty of them across
 * four hosts must not pay fifty lookups. What the cache costs is stated rather
 * than hidden: for up to {@link LOOKUP_TTL_MS} the fence judges the answer it
 * saw, not the answer Chromium will get. Neither half of the fence is the one
 * that dials, so a record that changes underneath both is outside what either
 * can promise — docs/BROWSER.md says so and so does the segment.
 *
 * @param lookup the resolver to wrap
 * @param now    the clock, injectable so the expiry is testable
 * @param ttlMs  how long an answer is reused
 */
export function cachedLookup(
  lookup: HostLookup,
  now: () => number = Date.now,
  ttlMs: number = LOOKUP_TTL_MS,
): HostLookup {
  const seen = new Map<string, { at: number; answers: Promise<string[]> }>();
  return (host) => {
    const hit = seen.get(host);
    if (hit && now() - hit.at < ttlMs) return hit.answers;
    const answers = lookup(host);
    seen.set(host, { at: now(), answers });
    // A failed lookup must not be remembered as a failure for the whole window.
    void answers.catch(() => seen.delete(host));
    return answers;
  };
}
