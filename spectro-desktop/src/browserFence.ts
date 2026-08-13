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
// One thing this half deliberately does NOT do: resolve DNS. The hook is
// synchronous per request and a resolver call per subresource would be a round
// trip on the page's critical path. Names are Java's to judge at the entry, and
// that split is written down in docs/BROWSER.md rather than papered over.

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

/** The one shape a refusal takes: what, why, and the rule's own name. */
function refusal(address: string, rule: string): FenceRefusal {
  return {
    address,
    rule,
    sentence: `refused ${address}: ${WHY[rule] ?? "the net fence refuses it"} (rule: ${rule}).`,
  };
}

/** "localhost" and anything under it, decided before any address parsing. */
function isLoopbackName(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost");
}

/** The rule an IPv6 literal breaks, or null. */
function ruleForV6(host: string): string | null {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "::1") return "loopback";
  if (bare === "::") return "unspecified";
  if (/^fe[89ab]/.test(bare)) return "link-local";
  if (/^f[cd]/.test(bare)) return "unique-local";
  if (/^ff/.test(bare)) return "multicast";
  return null;
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
  const rule = host.startsWith("[") ? ruleForV6(host) : ruleForV4(host);
  if (rule === "loopback") {
    return policy.allowLocalhost ? null : refusal(where, "loopback");
  }
  return rule === null ? null : refusal(where, rule);
}
