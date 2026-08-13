// The visible browser (card 201), on the engine card 200 decided.
//
// A WebContentsView laid over the desktop window's own content: a REAL browser
// pane inside the application, not a headless renderer with screenshots and not
// a second browser beside the app. The owner asked for the thing Claude Code
// has, and the brand rule ("the agent orchestrator you can watch") is satisfied
// by watching, not by streaming a picture of watching.
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
// neither proxy nor card.

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

const PARTITION = "persist:spectro-browser";
const CONSOLE_CAP = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Where the page may go, read fresh per request so a saved opt-in lands at once. */
let policy: FencePolicy = { allowLocalhost: false };
let adblockOn = true;
let filters: Blocklist = compileFilters(loadFilters());
let view: WebContentsView | null = null;
let reported: Rect | null = null;
/** Whether the view is in the window's tree. Adding it twice is not the same as showing it. */
let inWindow = false;
/** Whether the pane is on screen RIGHT NOW — the flag hidePane() must clear. */
let visible = false;
const consoleLines: ConsoleLine[] = [];
/** What the page's console said that the SHELL said, not the page. Counted, not dropped. */
let shellWarnings = 0;
/** What the hook refused since the last navigate — the pane's own honest record. */
let refusals: PaneRefusal[] = [];

/** One refused request, with the sentence the fence already produced for it. */
interface PaneRefusal {
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

/** The session the pane browses in — its own partition, never the app's. */
function paneSession(): Session {
  const ses = session.fromPartition(PARTITION);
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
        refusals.push({
          url: verdict.address, rule: verdict.rule, kind: "fence", sentence: verdict.sentence,
        });
        callback({ cancel: true });
        return;
      }
      if (adblockOn && filters.blocks(details.url, details.referrer ?? "", isTop)) {
        refusals.push({
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

/** The pane's own view, created on first use. */
function ensureView(): WebContentsView {
  if (view && !view.webContents.isDestroyed()) return view;
  const created = new WebContentsView({
    webPreferences: {
      session: paneSession(),
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
      shellWarnings += 1;
      return;
    }
    consoleLines.push({ level, text, at: Date.now() });
    if (consoleLines.length > CONSOLE_CAP) consoleLines.splice(0, consoleLines.length - CONSOLE_CAP);
  });
  wc.setWindowOpenHandler(() => ({ action: "deny" })); // one pane, one page
  view = created;
  return created;
}

/** Puts the pane on screen at the rectangle the web UI last measured. */
function layout(): void {
  const win = windowSource();
  if (!win || win.isDestroyed() || !view) return;
  const size = win.getContentBounds();
  view.setBounds(paneBounds(isUsable(reported) ? reported : null, size));
}

/**
 * Shows the pane, opening the window and switching the segment if it must.
 *
 * <p>Two flags, because they answer two different questions. "Is the view in
 * the window's tree" is asked once per view; "is the pane on screen" is asked
 * every time the operator navigates the app. Sharing one flag between them was
 * the measured defect: hidePane() left it set, so nav.browser was sent once per
 * process and the second tool call painted the pane over whatever the operator
 * had switched to, with the rail still highlighting the segment he chose.
 */
function ensureVisible(): void {
  const win = windowSource();
  if (!win || win.isDestroyed()) return;
  const created = ensureView();
  if (!inWindow) {
    win.contentView.addChildView(created);
    inWindow = true;
  }
  if (!visible) {
    visible = true;
    showSegment();
  }
  created.setVisible(true);
  layout();
}

/** Takes the pane off screen without destroying the page it is showing. */
export function hidePane(): void {
  if (view && visible) {
    view.setVisible(false);
    visible = false;   // so the next tool call asks for the segment back
  }
}

/**
 * Forgets the pane entirely, because the window that carried it is gone.
 *
 * <p>A WebContentsView dies with its window, so holding the reference after a
 * close means the next setVisible() reaches a destroyed object. Clearing it
 * here also puts the two visibility flags back where a fresh window expects
 * them.
 */
export function forgetPane(): void {
  view = null;
  inWindow = false;
  visible = false;
  reported = null;
  refusals = [];
  shellWarnings = 0;
  consoleLines.length = 0;
  forgetBaseUserAgent();
}

/** The address the pane is showing, for a failure sentence to name. */
export function paneUrl(): string | null {
  if (!view || view.webContents.isDestroyed()) return null;
  const url = view.webContents.getURL();
  return url && url !== "about:blank" ? url : null;
}

/** Whether a pane could be driven right now. */
export function paneAttached(): boolean {
  const win = windowSource();
  return win !== null && !win.isDestroyed();
}

function ok(value: unknown): PaneReply {
  return { ok: true, value, pageUrl: paneUrl() };
}

function failed(error: string): PaneReply {
  return { ok: false, error, pageUrl: paneUrl() };
}

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
 * Runs one verb against the pane.
 *
 * @param verb     the verb name, matching BrowserFace's own list
 * @param args     the verb's arguments as the Java side sent them
 * @param settings the policy that applies to this call
 */
export async function runVerb(
  verb: string,
  args: Record<string, unknown>,
  settings: PaneSettings,
): Promise<PaneReply> {
  policy = { allowLocalhost: settings.allowLocalhost === true };
  adblockOn = settings.adblock !== false;

  try {
    switch (verb) {
      case "status":
        return ok({ attached: paneAttached(), url: paneUrl(), visible });

      case "viewport": {
        // The web UI measured its placeholder. Not a browser verb — the seam
        // that lets a React layout position a native overlay without a preload
        // script, which navigationGuard.ts treats as a security property.
        const rect = args as unknown as Rect & { visible?: boolean };
        reported = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        if (rect.visible === false) {
          hidePane();
          return ok({ hidden: true });
        }
        if (view) {
          ensureVisible();
        }
        return ok({ bounds: reported });
      }

      case "navigate": {
        const url = String(args.url ?? "");
        // The Java entry check already ran. This one is not redundant: it is the
        // hook's own parser, and it reads old IPv4 spellings the way Chromium
        // will (fence-vectors.json carries the measured divergence).
        const verdict = refuse(url, policy);
        if (verdict) return failed(verdict.sentence);
        ensureVisible();
        refusals = [];
        consoleLines.length = 0;
        const wc = ensureView().webContents;
        try {
          await within(wc.loadURL(url), `loading ${url}`);
        } catch (stopped) {
          return failed(loadFailureSentence((stopped as Error).message, refusals));
        }
        const blocked = refusals.length;
        return ok({
          title: wc.getTitle(),
          url: wc.getURL(),
          blockedRequests: blocked,
          adblocked: refusals.filter((r) => r.kind === "adblock").length,
        });
      }

      case "eval": {
        if (!view) return failed("no page is open in the pane yet — navigate first");
        ensureVisible();
        // The four pinned semantics are executeJavaScript's own, not ours:
        // page context, act and sense in one call, a returned Promise awaited,
        // and the resolved value handed back structured. On raw CDP two of the
        // four are flags a caller can forget; here they cannot be.
        const value = await within(
          ensureView().webContents.executeJavaScript(String(args.text ?? ""), true),
          "the eval",
        );
        return ok({ value: value === undefined ? null : value });
      }

      case "screenshot": {
        if (!view) return failed("no page is open in the pane yet — navigate first");
        ensureVisible();
        // capturePage() THROWS when the pane has not painted (measured in the
        // card 200 spike: UnknownVizError, not an empty image), so the paint is
        // waited for rather than hoped for.
        await new Promise((resolve) => setTimeout(resolve, 120));
        const image = await within(ensureView().webContents.capturePage(), "the screenshot");
        const size = image.getSize();
        if (size.width === 0 || size.height === 0) {
          return failed("the pane has not painted yet — it may be hidden behind another segment");
        }
        return ok({
          mediaType: "image/png",
          dataBase64: image.toPNG().toString("base64"),
          width: size.width,
          height: size.height,
        });
      }

      case "input":
        return await input(args);

      case "read_page": {
        if (!view) return failed("no page is open in the pane yet — navigate first");
        const tree = await within(
          ensureView().webContents.executeJavaScript(
            readPageScript(String(args.filter ?? "interactive"), Number(args.maxChars ?? 8000)),
            true,
          ),
          "reading the page",
        );
        return ok({ tree: String(tree ?? "") });
      }

      case "find": {
        if (!view) return failed("no page is open in the pane yet — navigate first");
        const matches = await within(
          ensureView().webContents.executeJavaScript(findScript(String(args.query ?? "")), true),
          "the search",
        );
        if (matches === "NO_TREE") {
          return failed("nothing has been read yet — call browser_read_page first, "
            + "because find searches the tree that read produced");
        }
        return ok({ matches: String(matches ?? "") });
      }

      case "console": {
        const onlyErrors = args.onlyErrors === true;
        const pattern = args.pattern === undefined ? null : String(args.pattern).toLowerCase();
        const limit = Math.max(1, Math.min(500, Number(args.limit ?? 50)));
        const kept = consoleLines
          .filter((line) => !onlyErrors || /error|warn/i.test(line.level))
          .filter((line) => pattern === null || line.text.toLowerCase().includes(pattern))
          .slice(-limit)
          .map((line) => `[${line.level}] ${line.text}`);
        const blocked = refusals.length
          ? `\n(${refusals.length} request(s) refused since this page loaded: `
            + `${refusals.filter((r) => r.kind === "adblock").length} by the filter list, `
            + `${refusals.filter((r) => r.kind === "fence").length} by the net fence)`
          : "";
        // The dropped lines are named rather than silently absent, because the
        // tool whose job is "where a broken local build says what is wrong"
        // must not also be the tool that hides something.
        const shell = shellWarnings
          ? `\n(${shellWarnings} Electron security warning(s) from the shell itself left out — `
            + `they are not the page's)`
          : "";
        return ok({ lines: kept.join("\n") + blocked + shell });
      }

      case "resize": {
        if (!view) return failed("no page is open in the pane yet — navigate first");
        const width = Math.max(200, Number(args.width ?? 1280));
        const height = Math.max(200, Number(args.height ?? 800));
        // The pane keeps the rectangle the LAYOUT gave it and the page gets a
        // renderer-level override, so the two stop fighting: the previous
        // version called setBounds, which layout() overwrote on the next
        // ensureVisible(), and every other verb calls ensureVisible() first.
        const applied = await within(
          applyViewport(ensureView().webContents, width, height),
          "the resize",
        );
        return ok(applied);
      }

      default:
        return failed(`the pane does not know the verb "${String(verb).slice(0, 40)}"`);
    }
  } catch (error) {
    return failed((error as Error).message ?? String(error));
  }
}

/** The input verbs: real mouse and keyboard events into the pane's own renderer. */
async function input(args: Record<string, unknown>): Promise<PaneReply> {
  if (!view) return failed("no page is open in the pane yet — navigate first");
  ensureVisible();
  const wc = ensureView().webContents;
  const action = String(args.action ?? "");

  if (action === "wait") {
    const seconds = Math.max(0, Math.min(30, Number(args.duration ?? 1)));
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return ok({ detail: `waited ${seconds} s` });
  }

  let point: { x: number; y: number } | null = null;
  if (typeof args.ref === "string" && args.ref) {
    const resolved = (await wc.executeJavaScript(refRectScript(String(args.ref)), true)) as
      | { x: number; y: number }
      | null;
    if (!resolved) {
      return failed(`no element carries the handle ${String(args.ref).slice(0, 20)} — `
        + "read the page again, it may have re-rendered");
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
      return ok({ detail: `typed ${text.length} character(s)` });
    }
    case "key": {
      const key = String(args.text ?? "");
      if (!key) return failed("browser_computer action=key needs the key in `text`");
      wc.sendInputEvent({ type: "keyDown", keyCode: key });
      wc.sendInputEvent({ type: "char", keyCode: key });
      wc.sendInputEvent({ type: "keyUp", keyCode: key });
      return ok({ detail: `pressed ${key}` });
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
      return ok({ detail: `scrolled ${direction}` });
    }
    case "hover": {
      if (!point) return failed("browser_computer action=hover needs a coordinate or a ref");
      wc.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
      return ok({ detail: `hovered ${point.x},${point.y}` });
    }
    case "left_click":
    case "right_click":
    case "double_click": {
      if (!point) return failed(`browser_computer action=${action} needs a coordinate or a ref`);
      clickAt(wc, point, action === "double_click" ? 2 : 1,
        action === "right_click" ? "right" : "left");
      return ok({ detail: `${action} at ${point.x},${point.y}` });
    }
    default:
      return failed(`the pane does not know the input action "${action.slice(0, 40)}"`);
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
 * @param text the console message as the page reported it
 */
export function isPageLine(text: string): boolean {
  return !/^\s*Electron Security Warning/i.test(text);
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

/** Re-lays the pane after the window moved or resized. */
export function relayoutPane(): void {
  if (visible) layout();
}
