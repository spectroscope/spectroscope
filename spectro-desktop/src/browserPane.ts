// The visible browser (card 201), one per SESSION (card 218), on the engine card
// 200 decided.
//
// A WebContentsView laid over the desktop window's own content: a REAL browser
// pane inside the application, not a headless renderer with screenshots and not
// a second browser beside the app. The owner asked for the thing Claude Code
// has, and the brand rule ("the agent orchestrator you can watch") is satisfied
// by watching, not by streaming a picture of watching.
//
// Card 218 turned the one pane into a map keyed by session id, because the owner
// settled that the browser is a session feature: "weil jede session braucht ja
// seinen eigenen browser". The isolation is not a convention in this file — it is
// Chromium's own: each session's view browses in its OWN Electron session, so
// the cookie jar, localStorage, IndexedDB, the HTTP cache and the credential
// store all hang off a different object. Nothing in here has to remember to
// separate them, and nothing in here could merge them by accident.
//
// The trade, ratified by the owner and stated out loud: this is the DESKTOP face
// only. A reader running `spectro web` and pointing their own browser at the
// server gets no browser pane from this. Foreign sites refuse framing, the
// same-origin policy forbids reading or scripting what is framed (which kills
// eval, 41 % of the measured calls), and frame content cannot be rasterised —
// card 200 closed that road and this file does not reopen it.
//
// Two things ride the ONE request hook, and that is the security argument for
// this engine: session.webRequest.onBeforeRequest fires for the top-level
// navigation, every redirect hop and every subresource, in-process. The fence
// (card 199) and the filter list are both there. NetFence's own javadoc says
// what browse_page cannot do — "policing the browser's own traffic needs a
// proxy Chrome runs through, and that is its own card" — and this engine needs
// neither proxy nor card. With one Chromium session per spectroscope session the
// hook is installed once per partition, and each copy closes over the session it
// belongs to, so a refusal is recorded against the page that earned it.

import { BaseWindow, BrowserWindow, WebContentsView, session, type Session } from "electron";
import * as fs from "node:fs";
import * as dns from "node:dns";
import { compileFilters, DEFAULT_FILTERS, type Blocklist } from "./adblock";
import {
  cachedLookup, refuse, refuseResolved, type FenceRefusal, type FencePolicy, type HostLookup,
} from "./browserFence";
import { applyViewport, forgetBaseUserAgent } from "./deviceEmulation";
import { isUsable, paneBounds, type Rect } from "./paneBounds";
import { findScript, readPageScript, refRectScript } from "./pageScript";

/** One reply, exactly as the control channel puts it on the wire. */
export interface PaneReply {
  ok: boolean;
  value?: unknown;
  error?: string;
  pageUrl: string | null;
}

/** What the server told the shell about policy, refreshed with every command. */
export interface PaneSettings {
  allowLocalhost: boolean;
  /** Whether the filter list is on. Default on; a page under test can turn it off. */
  adblock: boolean;
}

/** One console line the page produced. */
interface ConsoleLine {
  level: string;
  text: string;
  at: number;
}

const PARTITION_PREFIX = "spectro-browser/";
const CONSOLE_CAP = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * One session's browser: its view, its screen state and everything its page
 * produced.
 *
 * Every field here was a module-level variable in card 201, which is the same
 * statement as "there was one browser". Moving them into a record keyed by
 * session id is the whole card: two sessions cannot share a console buffer, a
 * refusal log or a page, because they do not share this object.
 */
interface SessionPane {
  /** The session this browser belongs to — the store id, minted by the server. */
  readonly id: string;
  /** The Chromium partition name. The isolation boundary, in one string. */
  readonly partition: string;
  view: WebContentsView | null;
  /** Whether the view is in the window's tree. Adding it twice is not showing it. */
  inWindow: boolean;
  /** Whether this pane is on screen RIGHT NOW — the flag hidePane() must clear. */
  visible: boolean;
  lines: ConsoleLine[];
  /** What the page's console said that the SHELL said, not the page. Counted, not dropped. */
  shellWarnings: number;
  /** What the hook refused since the last navigate — the pane's own honest record. */
  refusals: PaneRefusal[];
}

/** Every open session's browser, keyed by session id. */
const panes = new Map<string, SessionPane>();

/**
 * How many browsers each session has already had in this app's life.
 *
 * Bumped when a browser is RETIRED and never when one opens, so a session's
 * first browser is opening 0 — which keeps `partitionFor(id)` on its own
 * meaningful to a guard or a probe asking about a session that only ever opened
 * one.
 *
 * It deliberately survives forgetPane(): the window going away destroys the
 * views, not the Chromium sessions behind them, so the next opening still needs
 * a name nothing has hooked. The cost is one string and one integer per session
 * that ever opened a browser, for as long as the app runs.
 */
const openings = new Map<string, number>();

/** Where the page may go, read fresh per request so a saved opt-in lands at once. */
let policy: FencePolicy = { allowLocalhost: false };
let adblockOn = true;
let filters: Blocklist = compileFilters(loadFilters());

/**
 * The rectangle the app reserved, in window coordinates.
 *
 * Window-global on purpose: every session's pane occupies the SAME hole in the
 * same window, because only one of them is on screen at a time. Keeping it per
 * session would mean a pane could be laid out from a rectangle the app measured
 * for a different surface.
 */
let reported: Rect | null = null;

/** One refused request, with the sentence the fence already produced for it. */
export interface PaneRefusal {
  url: string;
  rule: string;
  kind: "fence" | "adblock";
  sentence: string;
}

/**
 * The resolver the hook judges names with, cached for a short window.
 *
 * The seam exists because a test must not depend on DNS, and the cache exists
 * because the hook fires per subresource. Both are stated in browserFence.ts.
 */
let hostLookup: HostLookup = cachedLookup(async (host) => {
  const answers = await dns.promises.lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
});

/**
 * Replaces the resolver the request hook uses.
 *
 * @param lookup how a host name becomes addresses
 */
export function useHostLookup(lookup: HostLookup): void {
  hostLookup = lookup;
}

/**
 * The operator's own filter file, when they have one, else the shipped list.
 *
 * Card 200 section 9 left "which list, how it updates, what it costs to ship"
 * open, and it is still open. The shipped list is small and curated; this is the
 * seam for anyone who wants EasyList without the product having to ship, update
 * and license it.
 */
function loadFilters(): string[] {
  const path = process.env.SPECTRO_BROWSER_FILTERS;
  if (!path) return DEFAULT_FILTERS;
  try {
    return fs.readFileSync(path, "utf8").split("\n");
  } catch {
    return DEFAULT_FILTERS; // an unreadable file must not silently disable the list
  }
}

/**
 * The Chromium partition name for one session's browser — the isolation, in one
 * string, one OPENING at a time.
 *
 * Deliberately NOT a `persist:` partition. The owner's lifetime rule is "it
 * lives until the session is closed", and a persistent partition would outlive
 * the session on disk: a directory per session id that nothing ever deletes, and
 * a resumed id would find the cookies of a run that ended days ago.
 *
 * And deliberately a NEW name per opening, which is the correction card 218 was
 * sent back for. It shipped one name per session id and said the jar died with
 * the pane. Measured, it does not: Electron caches an in-memory Session by
 * partition name for the LIFE OF THE APP, so a closed session's cookies, its
 * localStorage and its HttpOnly login all stayed in the process, and a session
 * resumed under the same id opened onto them — logged in as whoever ran before.
 * Riding on the same cause, `paneSession()` installs the request hook once per
 * Session and it closes over the pane it was handed, so a second life's refusals
 * were pushed onto a dead record and the model got ERR_BLOCKED_BY_CLIENT instead
 * of the sentence naming the host and the rule. A fresh name per opening ends
 * both at once: a new Session, a fresh hook, an empty jar. `closeSession()`
 * empties the retired one as well, because a name nobody will use again is still
 * a credential sitting in memory.
 *
 * The id is sanitised because a partition name becomes a path component inside
 * Chromium, and a FINGERPRINT of the raw id rides along because sanitising is
 * lossy: `ab/c` and `ab:c` both flatten to `ab_c`, and the length that used to
 * ride here separates only ids of different length. Two sessions on one
 * partition is exactly the failure this card exists to prevent, so the belt its
 * own comment claimed is now really here.
 *
 * @param sessionId the session's store id
 * @param opening   which browser of that session's life — 0 is its first
 */
export function partitionFor(sessionId: string, opening = 0): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${PARTITION_PREFIX}${safe}-${fingerprint(sessionId)}-${opening}`;
}

/**
 * A short, stable fingerprint of the RAW session id (FNV-1a, 32 bit, base 36).
 *
 * Not a security hash and not asked to be one: its whole job is that two ids
 * which sanitise onto the same string still get two partitions.
 *
 * @param sessionId the session's store id, before sanitising
 */
function fingerprint(sessionId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * One session's Chromium session, with the fence and the filter list on its own
 * request hook.
 *
 * @param pane the session's browser
 */
function paneSession(pane: SessionPane): Session {
  const ses = session.fromPartition(pane.partition);
  if ((ses as unknown as { __spectroHooked?: boolean }).__spectroHooked) return ses;
  (ses as unknown as { __spectroHooked?: boolean }).__spectroHooked = true;

  // onBeforeRequest may answer asynchronously — that is how proxy and auth
  // flows are written — and it must, because a name has to be resolved before
  // the hop can be judged. A review measured what the synchronous version cost:
  // a 302 to a public name that resolves to loopback loaded with the opt-in OFF
  // and nothing was refused.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const isTop = details.resourceType === "mainFrame";
    const atPolicy = policy;
    void (async () => {
      let verdict: FenceRefusal | null = null;
      try {
        verdict = await refuseResolved(details.url, atPolicy, hostLookup);
      } catch {
        verdict = refuse(details.url, atPolicy);   // never let the fence fail open silently
      }
      if (verdict) {
        pane.refusals.push({
          url: verdict.address, rule: verdict.rule, kind: "fence", sentence: verdict.sentence,
        });
        callback({ cancel: true });
        return;
      }
      if (adblockOn && filters.blocks(details.url, details.referrer ?? "", isTop)) {
        pane.refusals.push({
          url: details.url, rule: "adblock", kind: "adblock",
          sentence: `the filter list blocked ${details.url}`,
        });
        callback({ cancel: true });
        return;
      }
      callback({});
    })();
  });
  return ses;
}

/** The window the pane lives in — the app's own, so the pane is inside the app. */
type WindowSource = () => BaseWindow | BrowserWindow | null;
let windowSource: WindowSource = () => null;

/** Asks the app's page to move to the browser segment, so the layout makes room. */
type SegmentRequest = () => void;
let showSegment: SegmentRequest = () => {};

/**
 * Wires the pane to the shell it lives in.
 *
 * @param source  how to get (or open) the app window
 * @param segment how to ask the app's page to show its browser segment
 */
export function attachPaneTo(source: WindowSource, segment: SegmentRequest): void {
  windowSource = source;
  showSegment = segment;
}

/**
 * One session's browser record, created on first use.
 *
 * @param sessionId the session's store id
 */
function paneFor(sessionId: string): SessionPane {
  const existing = panes.get(sessionId);
  if (existing) return existing;
  const created: SessionPane = {
    id: sessionId,
    partition: partitionFor(sessionId, openings.get(sessionId) ?? 0),
    view: null,
    inWindow: false,
    visible: false,
    lines: [],
    shellWarnings: 0,
    refusals: [],
  };
  panes.set(sessionId, created);
  return created;
}

/** The session's own view, created on first use. */
function ensureView(pane: SessionPane): WebContentsView {
  if (pane.view && !pane.view.webContents.isDestroyed()) return pane.view;
  const created = new WebContentsView({
    webPreferences: {
      session: paneSession(pane),
      // The page under test is untrusted input. It gets no Node, no preload and
      // its own sandboxed renderer — card 200 section 6, rule 4: javascript_exec
      // runs in the PAGE context, never a Node context, and there is no
      // equivalent of playwright-mcp's browser_run_code_unsafe here.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const wc = created.webContents;
  // Electron 43 hands one event object; older shapes passed positional args.
  // Both are read defensively so a console reader never becomes the reason a
  // browser call fails.
  wc.on("console-message", (...args: unknown[]) => {
    const event = args[0] as { level?: string | number; message?: string } | undefined;
    const level = String(event?.level ?? args[1] ?? "log");
    const text = String(event?.message ?? args[2] ?? "");
    if (!isPageLine(text)) {
      pane.shellWarnings += 1;
      return;
    }
    pane.lines.push({ level, text, at: Date.now() });
    if (pane.lines.length > CONSOLE_CAP) pane.lines.splice(0, pane.lines.length - CONSOLE_CAP);
  });
  wc.setWindowOpenHandler(() => ({ action: "deny" })); // one pane, one page
  pane.view = created;
  return created;
}

/** Puts a pane on screen at the rectangle the web UI last measured. */
function layout(pane: SessionPane): void {
  const win = windowSource();
  if (!win || win.isDestroyed() || !pane.view) return;
  const size = win.getContentBounds();
  pane.view.setBounds(paneBounds(isUsable(reported) ? reported : null, size));
}

/**
 * Shows one session's pane, opening the window and switching the segment if it
 * must — and taking every OTHER session's pane off screen first.
 *
 * <p>Two flags, because they answer two different questions. "Is the view in
 * the window's tree" is asked once per view; "is the pane on screen" is asked
 * every time the operator navigates the app. Sharing one flag between them was
 * the measured defect of card 201: hidePane() left it set, so nav.browser was
 * sent once per process and the native pane painted over whatever the operator
 * had switched to, with the rail still highlighting the segment he chose.
 *
 * <p>The single-pane rule is card 218's own: two native overlays over one
 * rectangle is the failure a div could never make, and the operator would be
 * watching the top one while the agent drove the other.
 */
function ensureVisible(pane: SessionPane): void {
  const win = windowSource();
  if (!win || win.isDestroyed()) return;
  const created = ensureView(pane);
  hideOthers(pane.id);
  if (!pane.inWindow) {
    win.contentView.addChildView(created);
    pane.inWindow = true;
  }
  if (!pane.visible) {
    pane.visible = true;
    showSegment();
  }
  created.setVisible(true);
  layout(pane);
}

/** Takes every pane except one off screen. */
function hideOthers(keep: string): void {
  for (const other of panes.values()) {
    if (other.id !== keep) hide(other);
  }
}

/** Takes one pane off screen without destroying the page it is showing. */
function hide(pane: SessionPane): void {
  if (pane.view && pane.visible) {
    pane.view.setVisible(false);
    pane.visible = false;   // so the next tool call asks for the segment back
  }
}

/** Takes whatever is on screen off it, without destroying any page. */
export function hidePane(): void {
  panes.forEach(hide);
}

/**
 * Gives back one browser's Chromium session — its cookies, its storage, its
 * cache — and retires the partition name with it.
 *
 * <p>Both halves are needed and neither is enough on its own. Emptying alone
 * would leave the next opening on the same Session object, whose request hook
 * still closes over the pane that just died: the fence would go on blocking and
 * stop saying why. A new name alone would leave the old jar, holding whatever
 * that page logged into, alive in the process until the app quits.
 *
 * <p>Fire and forget, and that is a requirement rather than a shortcut: this
 * runs on the path tearing a session down, and there is nothing to do with the
 * answer. What proves it really happened is a test that reads the jar back, not
 * a promise this function returns.
 *
 * @param pane the browser being given up
 */
function retire(pane: SessionPane): void {
  openings.set(pane.id, (openings.get(pane.id) ?? 0) + 1);
  try {
    const ses = session.fromPartition(pane.partition);
    void Promise.resolve(ses.clearStorageData()).catch(() => {});
    void Promise.resolve(ses.clearCache()).catch(() => {});
  } catch {
    // A Chromium session that is already gone needs no emptying.
  }
}

/**
 * Forgets every session's browser, because the window that carried them is gone.
 *
 * <p>A WebContentsView dies with its window, so holding the reference after a
 * close means the next setVisible() reaches a destroyed object.
 *
 * <p>Their Chromium sessions do NOT die with the window — that is the measured
 * fact this file used to get wrong — so each one is retired here exactly as a
 * close retires it. A window closed and reopened is otherwise a second life with
 * the first life's cookies and a hook pointing at a dead pane.
 */
export function forgetPane(): void {
  panes.forEach(retire);
  panes.clear();
  reported = null;
  forgetBaseUserAgent();
}

/**
 * Ends one session's browser: its page, its cookies and its storage.
 *
 * <p>What "closed" means here is the server's answer, not this file's — the
 * session's socket went away, which is the same event that cancels its run. The
 * stored transcript survives; the browser does not, because a browser is live
 * state and not a record.
 *
 * <p>The cookies and the storage go because retire() empties them and hands the
 * next opening a partition of its own. They did not, in the version this card
 * first shipped: "in memory" turned out to be a promise about the DISK, not
 * about the process, and Electron kept the jar keyed by partition name until the
 * app quit. A closed session's login was still there, and a resumed one walked
 * back into it.
 *
 * @param sessionId the session that closed
 */
export function closeSession(sessionId: string): void {
  const pane = panes.get(sessionId);
  if (!pane) return;
  panes.delete(sessionId);
  retire(pane);
  const view = pane.view;
  pane.view = null;
  if (!view) return;
  const win = windowSource();
  if (pane.inWindow && win && !win.isDestroyed()) {
    try {
      win.contentView.removeChildView(view);
    } catch {
      // The window may be tearing down around us; the view dies with it either way.
    }
  }
  try {
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch {
    // Same: a page that is already gone needs no second closing.
  }
}

/**
 * The address one session's pane is showing, for a failure sentence to name.
 *
 * @param sessionId the session whose browser is asked about
 */
export function paneUrl(sessionId: string | null): string | null {
  if (sessionId === null) return null;
  const pane = panes.get(sessionId);
  if (!pane || !pane.view || pane.view.webContents.isDestroyed()) return null;
  const url = pane.view.webContents.getURL();
  return url && url !== "about:blank" ? url : null;
}

/** Whether a pane could be driven right now. */
export function paneAttached(): boolean {
  const win = windowSource();
  return win !== null && !win.isDestroyed();
}

function ok(value: unknown, pane: SessionPane | null): PaneReply {
  return { ok: true, value, pageUrl: pane === null ? null : paneUrl(pane.id) };
}

function failed(error: string, pane: SessionPane | null): PaneReply {
  return { ok: false, error, pageUrl: pane === null ? null : paneUrl(pane.id) };
}

/**
 * The sentence a caller gets when it named no session.
 *
 * A browser per session means the shell must know WHOSE browser it is driving.
 * Serving "the" browser to a caller that named none is exactly the silent
 * substitution card 201 refused for tab_id, in the other direction.
 */
const NO_SESSION = "this command named no session, and every browser here belongs to one — "
  + "the shell cannot guess which page to drive";

/** Fails a promise that never settles, so one wedged page cannot wedge the agent. */
function within<T>(work: Promise<T>, what: string, ms = DEFAULT_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s`)), ms).unref?.(),
    ),
  ]);
}

/**
 * Runs one verb against one session's browser.
 *
 * @param verb      the verb name, matching BrowserFace's own list
 * @param args      the verb's arguments as the Java side sent them
 * @param settings  the policy that applies to this call
 * @param sessionId whose browser this is, or null when the caller named none
 */
export async function runVerb(
  verb: string,
  args: Record<string, unknown>,
  settings: PaneSettings,
  sessionId: string | null,
): Promise<PaneReply> {
  policy = { allowLocalhost: settings.allowLocalhost === true };
  adblockOn = settings.adblock !== false;

  // The rectangle is the WINDOW's, not a session's, so it is recorded even for a
  // page that has no session id yet: a fresh session mints its id on its first
  // prompt, and the hole it reserved is the same hole either way.
  if (verb === "viewport") {
    const rect = args as unknown as Rect & { visible?: boolean };
    reported = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    if (rect.visible === false || sessionId === null) {
      hidePane();
      return ok({ hidden: true, bounds: reported }, null);
    }
    // The app is showing THIS session's browser surface, so this is the pane
    // that belongs on screen — not whichever agent happened to run last.
    const pane = panes.get(sessionId);
    if (pane && pane.view) {
      ensureVisible(pane);
    } else {
      hideOthers(sessionId);
    }
    return ok({ bounds: reported }, pane ?? null);
  }

  if (sessionId === null) {
    return failed(NO_SESSION, null);
  }

  if (verb === "close_session") {
    closeSession(sessionId);
    return { ok: true, value: { closed: sessionId }, pageUrl: null };
  }

  const pane = paneFor(sessionId);

  try {
    switch (verb) {
      case "status":
        return ok({ attached: paneAttached(), url: paneUrl(pane.id), visible: pane.visible }, pane);

      case "navigate": {
        const url = String(args.url ?? "");
        // The Java entry check already ran. This one is not redundant: it is the
        // hook's own parser, and it reads old IPv4 spellings the way Chromium
        // will (fence-vectors.json carries the measured divergence).
        const verdict = refuse(url, policy);
        if (verdict) return failed(verdict.sentence, pane);
        ensureVisible(pane);
        pane.refusals = [];
        pane.lines.length = 0;
        const wc = ensureView(pane).webContents;
        try {
          await within(wc.loadURL(url), `loading ${url}`);
        } catch (stopped) {
          return failed(loadFailureSentence((stopped as Error).message, pane.refusals), pane);
        }
        return ok({
          title: wc.getTitle(),
          url: wc.getURL(),
          blockedRequests: pane.refusals.length,
          adblocked: pane.refusals.filter((r) => r.kind === "adblock").length,
        }, pane);
      }

      case "back":
      case "forward": {
        // Card 227: the desktop control row's history walk. Chromium's own
        // history, never a re-load of a remembered address — a re-load would
        // lose form state and repost, which is not what a back button does.
        // The refusal sentences are the headless face's own, verbatim, so the
        // UI reads one dialect whichever face is live.
        if (!pane.view) return failed(noPage(pane), pane);
        ensureVisible(pane);
        const wc = ensureView(pane).webContents;
        const nav = wc.navigationHistory;
        if (verb === "back" ? !nav.canGoBack() : !nav.canGoForward()) {
          return failed(verb === "back"
            ? "there is nothing earlier in this session's history"
            : "there is nothing later in this session's history", pane);
        }
        if (verb === "back") nav.goBack();
        else nav.goForward();
        // The walk hands back no load promise; give the pane the same beat the
        // screenshot's paint wait takes, then answer where it landed.
        await new Promise((resolve) => setTimeout(resolve, 120));
        return ok({ url: wc.getURL(), title: wc.getTitle() }, pane);
      }

      case "eval": {
        if (!pane.view) return failed(noPage(pane), pane);
        ensureVisible(pane);
        // The four pinned semantics are executeJavaScript's own, not ours:
        // page context, act and sense in one call, a returned Promise awaited,
        // and the resolved value handed back structured. On raw CDP two of the
        // four are flags a caller can forget; here they cannot be.
        const value = await within(
          ensureView(pane).webContents.executeJavaScript(String(args.text ?? ""), true),
          "the eval",
        );
        return ok({ value: value === undefined ? null : value }, pane);
      }

      case "screenshot": {
        if (!pane.view) return failed(noPage(pane), pane);
        ensureVisible(pane);
        // capturePage() THROWS when the pane has not painted (measured in the
        // card 200 spike: UnknownVizError, not an empty image), so the paint is
        // waited for rather than hoped for.
        await new Promise((resolve) => setTimeout(resolve, 120));
        const image = await within(ensureView(pane).webContents.capturePage(), "the screenshot");
        const size = image.getSize();
        if (size.width === 0 || size.height === 0) {
          return failed("the pane has not painted yet — it may be hidden behind another segment",
            pane);
        }
        return ok({
          mediaType: "image/png",
          dataBase64: image.toPNG().toString("base64"),
          width: size.width,
          height: size.height,
        }, pane);
      }

      case "input":
        return await input(args, pane);

      case "read_page": {
        if (!pane.view) return failed(noPage(pane), pane);
        const tree = await within(
          ensureView(pane).webContents.executeJavaScript(
            readPageScript(String(args.filter ?? "interactive"), Number(args.maxChars ?? 8000)),
            true,
          ),
          "reading the page",
        );
        return ok({ tree: String(tree ?? "") }, pane);
      }

      case "find": {
        if (!pane.view) return failed(noPage(pane), pane);
        const matches = await within(
          ensureView(pane).webContents.executeJavaScript(findScript(String(args.query ?? "")), true),
          "the search",
        );
        if (matches === "NO_TREE") {
          return failed("nothing has been read yet — call browser_read_page first, "
            + "because find searches the tree that read produced", pane);
        }
        return ok({ matches: String(matches ?? "") }, pane);
      }

      case "console": {
        const onlyErrors = args.onlyErrors === true;
        const pattern = args.pattern === undefined ? null : String(args.pattern).toLowerCase();
        const limit = Math.max(1, Math.min(500, Number(args.limit ?? 50)));
        const kept = pane.lines
          .filter((line) => !onlyErrors || /error|warn/i.test(line.level))
          .filter((line) => pattern === null || line.text.toLowerCase().includes(pattern))
          .slice(-limit)
          .map((line) => `[${line.level}] ${line.text}`);
        const blocked = pane.refusals.length
          ? `\n(${pane.refusals.length} request(s) refused since this page loaded: `
            + `${pane.refusals.filter((r) => r.kind === "adblock").length} by the filter list, `
            + `${pane.refusals.filter((r) => r.kind === "fence").length} by the net fence)`
          : "";
        // The dropped lines are named rather than silently absent, because the
        // tool whose job is "where a broken local build says what is wrong"
        // must not also be the tool that hides something.
        const shell = pane.shellWarnings
          ? `\n(${pane.shellWarnings} Electron security warning(s) from the shell itself left out — `
            + `they are not the page's)`
          : "";
        return ok({ lines: kept.join("\n") + blocked + shell }, pane);
      }

      case "resize": {
        if (!pane.view) return failed(noPage(pane), pane);
        const width = Math.max(200, Number(args.width ?? 1280));
        const height = Math.max(200, Number(args.height ?? 800));
        // The pane keeps the rectangle the LAYOUT gave it and the page gets a
        // renderer-level override, so the two stop fighting: the previous
        // version called setBounds, which layout() overwrote on the next
        // ensureVisible(), and every other verb calls ensureVisible() first.
        const applied = await within(
          applyViewport(ensureView(pane).webContents, width, height),
          "the resize",
        );
        return ok(applied, pane);
      }

      default:
        return failed(`the pane does not know the verb "${String(verb).slice(0, 40)}"`, pane);
    }
  } catch (error) {
    return failed((error as Error).message ?? String(error), pane);
  }
}

/** What a verb says when this session's browser has not opened anything yet. */
function noPage(pane: SessionPane): string {
  return `no page is open in this session's browser yet — navigate first (session ${pane.id})`;
}

/** The input verbs: real mouse and keyboard events into the pane's own renderer. */
async function input(args: Record<string, unknown>, pane: SessionPane): Promise<PaneReply> {
  if (!pane.view) return failed(noPage(pane), pane);
  ensureVisible(pane);
  const wc = ensureView(pane).webContents;
  const action = String(args.action ?? "");

  if (action === "wait") {
    const seconds = Math.max(0, Math.min(30, Number(args.duration ?? 1)));
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return ok({ detail: `waited ${seconds} s` }, pane);
  }

  let point: { x: number; y: number } | null = null;
  if (typeof args.ref === "string" && args.ref) {
    const resolved = (await wc.executeJavaScript(refRectScript(String(args.ref)), true)) as
      | { x: number; y: number }
      | null;
    if (!resolved) {
      return failed(`no element carries the handle ${String(args.ref).slice(0, 20)} — `
        + "read the page again, it may have re-rendered", pane);
    }
    point = resolved;
  } else if (Array.isArray(args.coordinate) && args.coordinate.length === 2) {
    point = { x: Number(args.coordinate[0]), y: Number(args.coordinate[1]) };
  }

  switch (action) {
    case "type": {
      const text = String(args.text ?? "");
      if (point) clickAt(wc, point, 1, "left");
      wc.insertText(text);
      return ok({ detail: `typed ${text.length} character(s)` }, pane);
    }
    case "key": {
      const key = String(args.text ?? "");
      if (!key) return failed("browser_computer action=key needs the key in `text`", pane);
      wc.sendInputEvent({ type: "keyDown", keyCode: key });
      wc.sendInputEvent({ type: "char", keyCode: key });
      wc.sendInputEvent({ type: "keyUp", keyCode: key });
      return ok({ detail: `pressed ${key}` }, pane);
    }
    case "scroll": {
      const amount = Number(args.scroll_amount ?? 3) * 100;
      const direction = String(args.scroll_direction ?? "down");
      const dx = direction === "left" ? amount : direction === "right" ? -amount : 0;
      const dy = direction === "up" ? amount : direction === "down" ? -amount : 0;
      const at = point ?? { x: 10, y: 10 };
      wc.sendInputEvent({
        type: "mouseWheel", x: at.x, y: at.y, deltaX: dx, deltaY: dy, canScroll: true,
      } as Parameters<typeof wc.sendInputEvent>[0]);
      return ok({ detail: `scrolled ${direction}` }, pane);
    }
    case "hover": {
      if (!point) return failed("browser_computer action=hover needs a coordinate or a ref", pane);
      wc.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
      return ok({ detail: `hovered ${point.x},${point.y}` }, pane);
    }
    case "left_click":
    case "right_click":
    case "double_click": {
      if (!point) {
        return failed(`browser_computer action=${action} needs a coordinate or a ref`, pane);
      }
      clickAt(wc, point, action === "double_click" ? 2 : 1,
        action === "right_click" ? "right" : "left");
      return ok({ detail: `${action} at ${point.x},${point.y}` }, pane);
    }
    default:
      return failed(`the pane does not know the input action "${action.slice(0, 40)}"`, pane);
  }
}

/** One synthetic mouse press and release, at the pane's own coordinates. */
function clickAt(
  wc: Electron.WebContents,
  point: { x: number; y: number },
  clickCount: number,
  button: "left" | "right",
): void {
  wc.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  wc.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button, clickCount });
  wc.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button, clickCount });
}

/**
 * Whether a console line came from the PAGE.
 *
 * Electron writes its own security warning into every page's console in a
 * development build — ten lines, twice after a redirect. browser_read_console
 * exists to be the first place a broken local build says what is wrong, and it
 * shipped with that buried under the shell's own boilerplate.
 *
 * The `%c` is not decoration and not defensiveness: Electron 43 writes
 * `console.warn("%cElectron Security Warning (…)%c\n…", "font-weight: bold;",
 * "")`, so the message arrives with the format directive still on the front and
 * the `^\s*` anchor never matched it. Measured against the shipped Electron
 * 43.3.0 on 2026-08-13, not remembered:
 * `"%cElectron Security Warning (Insecure Content-Security-Policy) font-weight:
 * bold; This renderer process has either no Co…"`. The filter was therefore
 * inert, `shellWarnings` was always 0, and the boilerplate went to the model
 * while the sentence promising to name what was left out never appeared.
 *
 * @param text the console message as the page reported it
 */
export function isPageLine(text: string): boolean {
  return !/^\s*(?:%[a-z]\s*)*Electron Security Warning/i.test(text);
}

/**
 * The sentence a failed load deserves.
 *
 * <p>ERR_BLOCKED_BY_CLIENT is what an ad blocker, a content extension and the
 * net fence all look like from the outside, and the model cannot tell them
 * apart. The hook already recorded WHY it cancelled, so the refusal is used
 * instead of the error code — and an ordinary failure passes through untouched,
 * because inventing a fence reason for a connection refused would be the same
 * dishonesty in the other direction.
 *
 * @param error   what loadURL threw
 * @param blocked what the hook refused during this load
 */
export function loadFailureSentence(error: string, blocked: PaneRefusal[]): string {
  const fenced = blocked.filter((r) => r.kind === "fence");
  if (fenced.length === 0) return error;
  const more = fenced.length > 1 ? ` (and ${fenced.length - 1} more)` : "";
  return `the net fence refused a hop on the way there: ${fenced[0].sentence}${more}`;
}

/** Re-lays whatever pane is on screen after the window moved or resized. */
export function relayoutPane(): void {
  panes.forEach((pane) => {
    if (pane.visible) layout(pane);
  });
}
