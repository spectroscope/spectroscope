// Filter-list blocking on the same request hook the fence rides.
//
// Card 201 acceptance criterion 5 is an either-outcome: make filter-list
// blocking demonstrably strip ads, or document why the chosen engine cannot.
// The answer is that it can, and cheaply — session.webRequest.onBeforeRequest
// already fires for every subresource, so the marginal cost of a filter list is
// a string match, not a second component.
//
// What ships here is a SMALL CURATED list, not EasyList. Card 200 section 9
// left "which list, how it updates, what it costs to ship" open, and that is
// still open: a 100k-rule list is a download, an update channel and a licence
// question, and none of the three belong inside this card. So the shipped list
// covers the hosts that carry most third-party ads and trackers, an operator can
// point SPECTRO_BROWSER_FILTERS at their own file of ABP-syntax rules, and the
// honest limit is written in docs/BROWSER.md: this blocks network requests, it
// does not hide elements, and it will not match a rule EasyList would.
//
// The syntax subset, deliberately narrow because a rule that only half works is
// worse than a rule that is absent:
//
//   ||host^        the host and its subdomains
//   /substring/    any URL containing it
//   @@rule         an exception, which wins
//   ! comment      ignored, as are blank lines and [Adblock Plus 2.0] headers
//   host##.sel     a COSMETIC rule; ignored, because this hook cannot hide an
//                  element and pretending otherwise is the silent omission the
//                  card refuses

/** One compiled list, ready to answer per request. */
export interface Blocklist {
  /** How many enforceable rules were kept — cosmetic and comment lines are not counted. */
  size: number;
  /**
   * Whether this request is an ad or a tracker.
   *
   * @param url         the request being made
   * @param pageUrl     the page it is being made from
   * @param isTopLevel  true for the document itself, which is never blocked
   */
  blocks(url: string, pageUrl: string, isTopLevel?: boolean): boolean;
}

/** A parsed rule: either a host anchor or a plain substring. */
interface Rule {
  kind: "host" | "substring";
  value: string;
  exception: boolean;
}

/**
 * The shipped list. Small on purpose, and every line is a network rule this hook
 * can actually enforce.
 */
export const DEFAULT_FILTERS: string[] = [
  "! spectroscope built-in filters (card 201). Network rules only.",
  "! Ad exchanges and the tag managers that load them.",
  "||doubleclick.net^",
  "||googlesyndication.com^",
  "||googleadservices.com^",
  "||googletagmanager.com^",
  "||google-analytics.com^",
  "||adservice.google.com^",
  "||amazon-adsystem.com^",
  "||adnxs.com^",
  "||criteo.com^",
  "||taboola.com^",
  "||outbrain.com^",
  "||scorecardresearch.com^",
  "||moatads.com^",
  "! Social trackers that ride along on article pages.",
  "||connect.facebook.net^",
  "||facebook.com/tr^",
  "! Generic paths and names, which catch first-party ad slots.",
  "/ads/",
  "/adserver/",
  "/pagead/",
  "banner-ad",
  "/advertisement",
];

/** Parses one line, or null when the line carries no enforceable rule. */
function parse(line: string): Rule | null {
  const text = line.trim();
  if (!text || text.startsWith("!") || text.startsWith("[")) {
    return null;
  }
  // Cosmetic rules hide elements. This hook cancels requests and cannot hide
  // anything, so they are dropped rather than silently mis-applied.
  if (text.includes("##") || text.includes("#@#")) {
    return null;
  }
  const exception = text.startsWith("@@");
  const body = exception ? text.slice(2) : text;
  if (body.startsWith("||")) {
    // ||host^ or ||host/path — everything up to the separator is the host.
    const host = body.slice(2).split(/[\^/]/, 1)[0].toLowerCase();
    const rest = body.slice(2 + host.length).replace(/^\^/, "");
    return host
      ? { kind: rest ? "substring" : "host", value: rest ? host + rest : host, exception }
      : null;
  }
  // Options ($third-party, $script) are not modelled; the rule before the $ is
  // still a useful substring, and a rule that claims an option it does not
  // honour would be worse than one that ignores it.
  const bare = body.split("$", 1)[0];
  return bare ? { kind: "substring", value: bare.toLowerCase(), exception } : null;
}

/** Whether a URL's host is this host or a subdomain of it. */
function hostMatches(url: string, host: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const name = parsed.hostname.toLowerCase();
  return name === host || name.endsWith("." + host);
}

/**
 * Compiles a list of ABP-syntax lines into something the request hook can ask
 * per request.
 *
 * @param lines the rule lines, in list order
 * @return the compiled list
 */
export function compileFilters(lines: string[]): Blocklist {
  const rules: Rule[] = [];
  for (const line of lines) {
    const rule = parse(line);
    if (rule) rules.push(rule);
  }
  const blockRules = rules.filter((r) => !r.exception);
  const exceptions = rules.filter((r) => r.exception);

  const hits = (rule: Rule, url: string): boolean =>
    rule.kind === "host" ? hostMatches(url, rule.value) : url.toLowerCase().includes(rule.value);

  return {
    size: blockRules.length,
    blocks(url: string, _pageUrl: string, isTopLevel = false): boolean {
      // The document the operator is looking at is never blocked. A filter list
      // is a heuristic, and a heuristic that can blank the pane would cost more
      // trust than the ads it removes.
      if (isTopLevel) return false;
      if (!blockRules.some((rule) => hits(rule, url))) return false;
      return !exceptions.some((rule) => hits(rule, url));
    },
  };
}
