// The address of what the app is showing (card 131), grown around the card-81
// grammar for a moment in a run: `#/session/{id}@{n}`.
//
// The vocabulary: `#/` is the live default · `#/{tab}` a live view tab ·
// `#/session/{id}[@{n}][/{tab}]` a session, optionally at an event, optionally
// on a tab · `#/fleet/{contextId}` a fleet landing · `#/settings[/{section}]`
// the settings page. Replay-only ids (scenario:*, import:*) are never
// addresses: the formatter writes `#/` for them and the parser refuses them —
// those views exist without a URL.
//
// Parsing is deliberately forgiving in one direction and strict in the other.
// A malformed index opens the session unseeked rather than guessing a frame,
// an unknown section opens settings plain, and an address that names nothing
// real falls to the live default — landing wrong is worse than landing home.

/**
 * The seven view tabs a hash may name. The literals ARE the URL segments.
 *
 * `browser` joined them on card 218: the owner settled that the visible browser
 * is a session feature — "weil jede session braucht ja seinen eigenen browser" —
 * so it belongs in the session's own tab row, which binds it to the session by
 * construction and gives it an address a link can land on.
 */
export const VIEW_TABS = ["chat", "spectrum", "graph", "trace", "text", "lab", "browser"] as const;
export type ViewTab = (typeof VIEW_TABS)[number];

/** The settings sections a hash may name. */
export const SETTINGS_SECTIONS = [
  "design",
  "language",
  "session",
  "leveling",
  "observability",
  "fleet",
  // Card 184 leg 2b: speech needs a model this app can fetch and one binary
  // it must only report, so it earns a section a link can land on.
  "stt",
  // Card 203: choosing how the product searches the web is a settings visit
  // with visible options, so it earns an address a link can land on.
  "websearch",
  // Card 199: the auto-approve allowlist and the net fence. Both are permission
  // surfaces a reader has to be able to LINK somebody at.
  "allowlist",
  "netfence",
  // Card 195: the shell hooks. The only surface in this list that configures
  // code THIS product executes, which is exactly why somebody has to be able to
  // send somebody else straight at it.
  "hooks",
  "workspace",
  "logging",
  "machine",
  // Card 224: the plus menu's Manage/Browse rows land HERE — the menu is the
  // fast switch, these pages stay the full account, and each needs an address
  // a menu entry (and a person helping another person) can point at.
  "skills",
  "skills-catalogue",
  "mcp",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The state inside a view — see viewState.ts for what is worth writing. */
import { formatViewState, parseViewState, type ViewState } from "./viewState";
export type { ViewState };

/** Everything a hash can address. */
export type Route =
  | { kind: "live"; tab: ViewTab | null; view?: ViewState }
  | { kind: "session"; sessionId: string; eventIndex: number | null; tab: ViewTab | null; view?: ViewState }
  | { kind: "fleet"; contextId: string }
  /**
   * A transcript from the store, by its store-relative path.
   *
   * An import used to be a view and nothing else, because a pasted body and a
   * picked file genuinely have no address. A transcript in the store DOES have
   * one, and the difference stopped being academic the moment a session's
   * agents became openable (card 177): a reader opens a workflow's agent, lands
   * in it, and has no way back, because the thing he came from was never an
   * address either. So the ones that CAN be addressed now are.
   */
  | { kind: "import"; path: string; tab: ViewTab | null; view?: ViewState }
  | { kind: "settings"; section: SettingsSection | null };

/** A parsed session route — the card-81 shape, kept for its callers. */
export interface SessionRoute {
  sessionId: string;
  /** The event to seek to, or null to open the session as it is. */
  eventIndex: number | null;
}

const SESSION = "session/";
const FLEET = "fleet/";
const SETTINGS = "settings";
const IMPORT = "import/";

/**
 * Reads any hash into a route. Total: an address that names nothing real is
 * the live default, never an exception.
 *
 * @param hash the hash, with or without its leading `#`
 * @return the parsed route
 */
export function parseAppRoute(hash: string | null | undefined): Route {
  if (!hash) {
    return liveDefault();
  }
  const whole = hash.startsWith("#") ? hash.slice(1) : hash;
  // The query is split off BEFORE anything else looks at the path, so no parser
  // below has to know it exists — and a `?` inside an encoded store path is
  // %3F, so this cannot cut one in half.
  const q = whole.indexOf("?");
  const path = q < 0 ? whole : whole.slice(0, q);
  const view = parseViewState(q < 0 ? undefined : whole.slice(q + 1));
  if (!path.startsWith("/")) {
    return liveDefault();
  }
  const rest = path.slice(1);
  if (rest === "") {
    return liveDefault();
  }
  if (isViewTab(rest)) {
    return withView({ kind: "live", tab: rest }, view);
  }
  if (rest.startsWith(SESSION)) {
    return withView(sessionRouteOf(rest.slice(SESSION.length)), view);
  }
  if (rest.startsWith(FLEET)) {
    return fleetRouteOf(rest.slice(FLEET.length));
  }
  if (rest.startsWith(IMPORT)) {
    return withView(importRouteOf(rest.slice(IMPORT.length)), view);
  }
  if (rest === SETTINGS) {
    return { kind: "settings", section: null };
  }
  if (rest.startsWith(SETTINGS + "/")) {
    return settingsRouteOf(rest.slice(SETTINGS.length + 1));
  }
  return liveDefault();
}

/**
 * Stamps view state onto a route that can carry it.
 *
 * A fleet landing and the settings page cannot: neither has a view whose state
 * would mean anything, and a query on them would be an address that promises
 * something nothing reads.
 */
function withView(route: Route, view: ViewState): Route {
  if (isEmpty(view)) return route;
  switch (route.kind) {
    case "live":
    case "session":
    case "import":
      return { ...route, view };
    default:
      return route;
  }
}

const isEmpty = (v: ViewState): boolean => v.row === undefined && v.only === undefined && v.win === undefined;

/**
 * Builds the hash for a route, always with its leading `#`.
 *
 * Replay-only ids (scenario:*, import:*) come back as `#/` — a scenario or an
 * import is a view, not an address, and must never reach the URL bar.
 */
export function formatRoute(route: Route): string {
  switch (route.kind) {
    case "live":
      return (route.tab === null ? "#/" : `#/${route.tab}`) + formatViewState(route.view);
    case "session": {
      if (isReplayOnlyId(route.sessionId)) {
        return "#/";
      }
      let hash = `#/${SESSION}${encodeURIComponent(route.sessionId)}`;
      if (route.eventIndex !== null) {
        hash += `@${route.eventIndex}`;
      }
      if (route.tab !== null) {
        hash += `/${route.tab}`;
      }
      return hash + formatViewState(route.view);
    }
    case "fleet":
      return isReplayOnlyId(route.contextId) ? "#/" : `#/${FLEET}${encodeURIComponent(route.contextId)}`;
    case "import": {
      if (route.path === "") {
        return "#/";
      }
      // The path is URL-ENCODED, so its own slashes are %2F and the only bare
      // slash left is the one this appends. That is what makes the tab suffix
      // unambiguous for a path that happens to end in a tab's name.
      const hash = `#/${IMPORT}${encodeURIComponent(route.path)}`;
      return (route.tab === null ? hash : `${hash}/${route.tab}`) + formatViewState(route.view);
    }
    case "settings":
      return route.section === null ? `#/${SETTINGS}` : `#/${SETTINGS}/${route.section}`;
  }
}

/**
 * A store transcript address, or the live default.
 *
 * The path is the store-relative one the listing hands out, and the decode is
 * the only thing done to it: the server resolves it canonically and refuses
 * anything outside the store, so this side does not need a second opinion about
 * what a path may say.
 *
 * @param raw the encoded path after `#/import/`
 * @return the import route, or the live default for an empty one
 */
function importRouteOf(raw: string): Route {
  // A trailing `/{tab}` is a tab only when the literal matches AND a path
  // remains. The path itself arrives percent-encoded, so a bare slash here
  // cannot have come from inside it — which is why a transcript whose own path
  // ends in "trace" still parses as a path and not as a tab.
  let rest = raw;
  let tab: ViewTab | null = null;
  const cut = rest.lastIndexOf("/");
  if (cut > 0) {
    const maybe = rest.slice(cut + 1);
    if (isViewTab(maybe)) {
      tab = maybe;
      rest = rest.slice(0, cut);
    }
  }
  let path: string;
  try {
    path = decodeURIComponent(rest);
  } catch {
    // A hand-typed hash with a stray % is not an address; it is a typo.
    return liveDefault();
  }
  return path === "" ? liveDefault() : { kind: "import", path, tab };
}

/**
 * Reads a session route out of a location hash — the card-81 surface, now a
 * view onto the full grammar (a `/{tab}` suffix parses and is dropped here).
 *
 * @param hash the hash, with or without its leading `#`
 * @return the route, or null when the hash addresses something else
 */
export function parseRoute(hash: string | null | undefined): SessionRoute | null {
  const route = parseAppRoute(hash);
  return route.kind === "session" ? { sessionId: route.sessionId, eventIndex: route.eventIndex } : null;
}

/**
 * Builds the hash for a session, optionally at an event.
 *
 * @param sessionId the session
 * @param eventIndex the event to land on, or null for the session as it is
 * @return the hash, including its leading `#`
 */
export function formatSessionRoute(sessionId: string, eventIndex: number | null): string {
  return formatRoute({ kind: "session", sessionId, eventIndex, tab: null });
}

function liveDefault(): Route {
  return { kind: "live", tab: null };
}

function isViewTab(segment: string): segment is ViewTab {
  return (VIEW_TABS as readonly string[]).includes(segment);
}

function isSettingsSection(segment: string): segment is SettingsSection {
  return (SETTINGS_SECTIONS as readonly string[]).includes(segment);
}

/** Scenario and import replays live outside the URL; their ids address nothing. */
function isReplayOnlyId(id: string): boolean {
  return id.startsWith("scenario:") || id.startsWith("import:");
}

function sessionRouteOf(rest: string): Route {
  if (rest === "") {
    return liveDefault();
  }
  // A trailing /{tab} is a tab only when the literal matches AND an id remains;
  // any other slash belongs to the id (formatted ids encode theirs away).
  let tab: ViewTab | null = null;
  let core = rest;
  const slash = rest.lastIndexOf("/");
  if (slash > 0) {
    const suffix = rest.slice(slash + 1);
    if (isViewTab(suffix)) {
      tab = suffix;
      core = rest.slice(0, slash);
    }
  }
  // The last @ wins: a session id may contain one, an index may not.
  const at = core.lastIndexOf("@");
  const rawId = at === -1 ? core : core.slice(0, at);
  const rawIndex = at === -1 ? "" : core.slice(at + 1);
  if (rawId === "") {
    return liveDefault();
  }
  const sessionId = safeDecode(rawId);
  if (isReplayOnlyId(sessionId)) {
    return liveDefault();
  }
  return { kind: "session", sessionId, eventIndex: wholeIndex(rawIndex), tab };
}

function fleetRouteOf(rest: string): Route {
  if (rest === "") {
    return liveDefault();
  }
  const contextId = safeDecode(rest);
  if (isReplayOnlyId(contextId)) {
    return liveDefault();
  }
  return { kind: "fleet", contextId };
}

function settingsRouteOf(rest: string): Route {
  return { kind: "settings", section: isSettingsSection(rest) ? rest : null };
}

/** Only a whole, non-negative number addresses an event; anything else is none. */
function wholeIndex(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** A hand-typed hash may not be valid percent-encoding; take it literally then. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
