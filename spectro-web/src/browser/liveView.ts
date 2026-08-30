// The web face's picture wire (card 226): the pure half of the live browser
// view.
//
// The server spawns a headless Chrome per session and streams its screencast
// down /ws/browser-view; this module is everything about that wire that can be
// tested without a DOM — parsing the five server frames, building the client
// frames in `browser_computer`'s own argument names, and the two coordinate
// translations. The component (BrowserSegment) holds only the socket and the
// event glue.
//
// The server side of the same wire is pinned by BrowserViewSocketTest and
// documented in docs/BROWSER.md ("The picture channel"). Argument names are
// browser_computer's own, deliberately: the UI and the agent's tools speak one
// dialect, so the face runs an operator's click through the same switch as the
// agent's.

/** Which engine would serve a browser verb right now — the server's answer. */
export type FaceLive = "desktop" | "web" | "none";

/** One `state` frame: whose browser is live, and what page it is on. */
export interface ViewState {
  live: FaceLive;
  url: string | null;
  attached: boolean;
  /**
   * Whether the live engine has anywhere to go back to — and `null` for "it
   * did not say" (card 344, criterion 3).
   *
   * THREE states, deliberately, and the third one is the whole design. Only
   * the web face can answer this freshly: its engine reports every main-frame
   * navigation up this channel, so its answer is exactly as fresh as the
   * address beside it. The desktop shell pushes nothing — its address and its
   * history are both a cache the server refreshes when a verb runs — so a
   * boolean from that face would go stale the moment the operator clicks a
   * link on the real pane, and a stale `false` here is a button that is dead
   * while the thing it does would work.
   *
   * So an unknown answer NEVER disables. The desktop face keeps the behaviour
   * it has today: press it, and read the sentence if there was nothing there.
   */
  canGoBack: boolean | null;
  canGoForward: boolean | null;
}

/** One screencast frame, ready to draw: bytes as a data URL, size in device
 *  (page CSS) pixels — the space CDP input wants coordinates in. */
export interface ViewPicture {
  dataUrl: string;
  deviceWidth: number;
  deviceHeight: number;
  ts: number;
}

/** A screenshot's bytes riding a verb answer (card 227): the desktop face has
 *  no client-side picture to save, so the shot travels back as verb fields. */
export interface VerbShot {
  mediaType: string;
  dataBase64: string;
}

/** One row of the start page (card 227): a launch configuration, with what the
 *  session's supervisor says about it right now. */
export interface LaunchConfigRow {
  name: string;
  /** Where the play button would point the browser, or null when the entry
   *  names neither a port nor a url. */
  address: string | null;
  /** True for an entry spectroscope cannot run — play attaches, spawns nothing. */
  attaches: boolean;
  up: boolean;
  /** The exit code of a run that ended, or null while none did. */
  exitCode: number | null;
}

/** The start page's data: the session's configurations, or the sentence that
 *  says why there are none to list. */
export interface LaunchList {
  ok: boolean;
  sentence: string | null;
  /** How many entries the launch file carries that could not be offered. */
  skipped: number;
  configs: LaunchConfigRow[];
}

/** Everything the server can say, discriminated for the component's switch. */
export type ViewMessage =
  | { kind: "state"; state: ViewState }
  | { kind: "frame"; picture: ViewPicture }
  | {
      kind: "verb";
      verb: string;
      ok: boolean;
      url: string | null;
      error: string | null;
      shot: VerbShot | null;
    }
  | { kind: "refused"; sentence: string }
  | { kind: "error"; sentence: string }
  | ({ kind: "launchConfigs" } & LaunchList)
  | {
      kind: "launchPlayed";
      name: string;
      ok: boolean;
      /** Whether the configuration itself came up — card 202's split: a fence
       *  refusal leaves the server running and only the browser away. */
      up: boolean;
      url: string | null;
      sentence: string | null;
    };

/** The channel's address on the page's own origin — the same trust as /ws. */
export function viewSocketUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws/browser-view`;
}

/**
 * Boundary parse of one server frame.
 *
 * Unknown types answer null (forward compatibility, like the RunEvent wire);
 * an unknown `live` value coerces to "none", because the floor is the safe
 * direction — a face this build does not know must not paint pictures. A
 * picture frame without bytes is dropped rather than drawn broken.
 *
 * @param data whatever the socket delivered
 * @return the message, or null for what is not this wire
 */
export function parseViewMessage(data: unknown): ViewMessage | null {
  if (typeof data !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const frame = raw as Record<string, unknown>;
  switch (frame.type) {
    case "state": {
      const live: FaceLive =
        frame.live === "desktop" || frame.live === "web" || frame.live === "none" ? frame.live : "none";
      return {
        kind: "state",
        state: {
          live,
          url: typeof frame.url === "string" ? frame.url : null,
          attached: frame.attached === true,
          canGoBack: typeof frame.canGoBack === "boolean" ? frame.canGoBack : null,
          canGoForward: typeof frame.canGoForward === "boolean" ? frame.canGoForward : null,
        },
      };
    }
    case "frame": {
      const bytes = typeof frame.dataBase64 === "string" ? frame.dataBase64 : "";
      if (bytes === "") return null;
      return {
        kind: "frame",
        picture: {
          dataUrl: frameDataUrl(bytes),
          deviceWidth: typeof frame.deviceWidth === "number" ? frame.deviceWidth : 0,
          deviceHeight: typeof frame.deviceHeight === "number" ? frame.deviceHeight : 0,
          ts: typeof frame.ts === "number" ? frame.ts : 0,
        },
      };
    }
    case "verb":
      return {
        kind: "verb",
        verb: typeof frame.verb === "string" ? frame.verb : "",
        ok: frame.ok === true,
        url: typeof frame.url === "string" ? frame.url : null,
        error: typeof frame.error === "string" ? frame.error : null,
        shot:
          typeof frame.mediaType === "string" && typeof frame.dataBase64 === "string"
            ? { mediaType: frame.mediaType, dataBase64: frame.dataBase64 }
            : null,
      };
    case "refused":
      return { kind: "refused", sentence: typeof frame.sentence === "string" ? frame.sentence : "" };
    case "error":
      return { kind: "error", sentence: typeof frame.sentence === "string" ? frame.sentence : "" };
    case "launch_configs": {
      // Tolerant like every boundary parse on this wire: a row without a name
      // cannot be started by name, so it is dropped rather than rendered blind.
      const rows: LaunchConfigRow[] = [];
      if (Array.isArray(frame.configs)) {
        for (const raw of frame.configs) {
          if (typeof raw !== "object" || raw === null) continue;
          const entry = raw as Record<string, unknown>;
          if (typeof entry.name !== "string" || entry.name === "") continue;
          rows.push({
            name: entry.name,
            address: typeof entry.address === "string" ? entry.address : null,
            attaches: entry.attaches === true,
            up: entry.up === true,
            exitCode: typeof entry.exitCode === "number" ? entry.exitCode : null,
          });
        }
      }
      return {
        kind: "launchConfigs",
        ok: frame.ok === true,
        sentence: typeof frame.sentence === "string" ? frame.sentence : null,
        skipped: typeof frame.skipped === "number" ? frame.skipped : 0,
        configs: rows,
      };
    }
    case "launch_played":
      return {
        kind: "launchPlayed",
        name: typeof frame.name === "string" ? frame.name : "",
        ok: frame.ok === true,
        up: frame.up === true,
        url: typeof frame.url === "string" ? frame.url : null,
        sentence: typeof frame.sentence === "string" ? frame.sentence : null,
      };
    default:
      return null;
  }
}

/** What the segment renders: connecting until the first state frame answers,
 *  then the server's own word for which face is live. */
export type WebFaceMode = "connecting" | "desktop" | "web" | "none";

/** @return the mode for the state the socket has, or "connecting" before one */
export function webFaceMode(state: ViewState | null): WebFaceMode {
  if (state === null) return "connecting";
  return state.live;
}

/**
 * The i18n key naming the live face — criterion 5's honesty, said in the bar
 * rather than left for the reader to deduce from whether pixels move.
 *
 * @param mode a settled mode (the connecting state has no face to name)
 */
export function faceLabelKey(mode: Exclude<WebFaceMode, "connecting">): string {
  switch (mode) {
    case "web":
      return "browser.view.faceWeb";
    case "desktop":
      return "browser.view.faceDesktop";
    default:
      return "browser.view.faceNone";
  }
}

/**
 * A point on the shown picture, translated into the page's own pixels.
 *
 * The screencast is capped (1280x800) and the segment scales it again to fit
 * the hole, so the picture on screen is neither the page's size nor the
 * frame's; only the ratio survives. CDP input wants device (page CSS) pixels,
 * which every frame carries as its metadata.
 *
 * @return the device point, rounded and clamped — or null when any dimension
 *         is missing, because a guessed click lands somewhere real
 */
export function toDevicePoint(
  px: number,
  py: number,
  shownWidth: number,
  shownHeight: number,
  deviceWidth: number,
  deviceHeight: number,
): [number, number] | null {
  if (shownWidth <= 0 || shownHeight <= 0 || deviceWidth <= 0 || deviceHeight <= 0) return null;
  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max - 1);
  return [
    clamp(Math.round((px / shownWidth) * deviceWidth), deviceWidth),
    clamp(Math.round((py / shownHeight) * deviceHeight), deviceHeight),
  ];
}

/** One flushed wheel gesture as the face's scroll arguments. */
export interface ScrollStep {
  direction: "up" | "down" | "left" | "right";
  amount: number;
}

/** The face turns one scroll_amount step into 100 wheel pixels; the inverse
 *  lives here so the two stay each other's mirror. */
const WHEEL_PX_PER_STEP = 100;

/** More than this in ONE flush is a flung trackpad, not a request to leave. */
const WHEEL_MAX_STEPS = 15;

/**
 * Accumulated wheel deltas as one scroll step on the dominant axis.
 *
 * Signs are the DOM's own (positive deltaY means scroll down), which is also
 * CDP's convention — the face pins that the Electron pane's inverted sign is
 * NOT copied here, so this function forwards the sign untouched.
 *
 * @return the step, or null when nothing accumulated
 */
export function wheelStep(deltaX: number, deltaY: number): ScrollStep | null {
  const dominant = Math.abs(deltaY) >= Math.abs(deltaX) ? deltaY : deltaX;
  if (dominant === 0) return null;
  const vertical = Math.abs(deltaY) >= Math.abs(deltaX);
  const amount = Math.min(WHEEL_MAX_STEPS, Math.max(1, Math.round(Math.abs(dominant) / WHEEL_PX_PER_STEP)));
  if (vertical) return { direction: deltaY > 0 ? "down" : "up", amount };
  return { direction: deltaX > 0 ? "right" : "left", amount };
}

/** The named keys the headless face has codes for — its own switch, mirrored.
 *  Tab and Escape are deliberately absent: Tab is how a keyboard reader LEAVES
 *  the picture, and Escape is how focus lets go, so forwarding either would
 *  trap the one reader the aria labels exist for. */
const FORWARDED_KEYS = new Set([
  "Enter",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * Which key name to forward for one keydown, or null for keys the app keeps.
 *
 * Printable characters pass as themselves (the DOM has already applied shift),
 * named keys pass when the engine knows a code for them, and anything under
 * ctrl or meta stays the app's and the OS's — a forwarded cmd+r would reload
 * the wrong browser.
 *
 * @param key  KeyboardEvent.key
 * @param ctrl whether control was held
 * @param meta whether meta (cmd) was held
 */
export function keyName(key: string, ctrl: boolean, meta: boolean): string | null {
  if (ctrl || meta) return null;
  if (key.length === 1) return key;
  return FORWARDED_KEYS.has(key) ? key : null;
}

/**
 * The address the reader typed, made dialable.
 *
 * A bare host gets https lent to it — the fence and the engine both want a
 * scheme, and "example.test" typed into an address bar means the site, not a
 * parse error. A schemed address passes untouched so the fence judges what was
 * actually asked for.
 *
 * @return the address to navigate to, or null when the line was empty
 */
export function typedAddress(typed: string): string | null {
  const trimmed = typed.trim();
  if (trimmed === "") return null;
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** @return the subscribe frame for one session's picture */
export function watchFrame(sessionId: string): Record<string, unknown> {
  return { type: "watch", sessionId };
}

/** @return the unsubscribe frame */
export function unwatchFrame(): Record<string, unknown> {
  return { type: "unwatch" };
}

/** @return the navigate frame — the server runs the entry fence before any
 *          engine is spawned for it */
export function navigateFrame(sessionId: string, url: string): Record<string, unknown> {
  return { type: "navigate", sessionId, url };
}

/** @return the back/forward frame — these two verbs exist only on this face */
export function historyFrame(sessionId: string, direction: "back" | "forward"): Record<string, unknown> {
  return { type: direction, sessionId };
}

/**
 * The reload verb (card 344, criterion 2).
 *
 * It carries NO address, and that absence is the fix. The control used to send
 * a navigate frame naming the remembered address, which throws away what was
 * typed into a form and re-posts what was posted — the behaviour the desktop
 * shell refuses in writing for back/forward one file away (`browserPane.ts`,
 * the back/forward case). The engine reloads the document it is holding.
 *
 * @return the reload frame
 */
export function reloadFrame(sessionId: string): Record<string, unknown> {
  return { type: "reload", sessionId };
}

/**
 * The close verb (card 346): drop the page, keep the login.
 *
 * The Chromium partition, its cookies and its cache are deliberately NOT
 * touched — the owner's call: closing a tab in a real browser does not sign
 * you out. What goes is the view.
 *
 * @return the close_page frame
 */
export function closePageFrame(sessionId: string): Record<string, unknown> {
  return { type: "close_page", sessionId };
}

/** @return a left click at a device point, as browser_computer would say it */
export function clickFrame(sessionId: string, point: [number, number]): Record<string, unknown> {
  return { type: "input", sessionId, action: "left_click", coordinate: point };
}

/** @return a scroll at a device point, in browser_computer's own names */
export function scrollFrame(
  sessionId: string,
  point: [number, number],
  direction: ScrollStep["direction"],
  amount: number,
): Record<string, unknown> {
  return {
    type: "input",
    sessionId,
    action: "scroll",
    coordinate: point,
    scroll_direction: direction,
    scroll_amount: amount,
  };
}

/** @return one key press, named the way the face's own switch names it */
export function keyFrame(sessionId: string, key: string): Record<string, unknown> {
  return { type: "input", sessionId, action: "key", text: key };
}

/** @return the start page's ask: which configurations, and what is up now */
export function launchListFrame(sessionId: string): Record<string, unknown> {
  return { type: "launch_list", sessionId };
}

/** @return the play button: start one configuration and open the browser on it */
export function launchPlayFrame(sessionId: string, name: string): Record<string, unknown> {
  return { type: "launch_play", sessionId, name };
}

/** @return the screenshot ask for a face with no client-side picture to save —
 *          the shot comes back as verb fields (card 227) */
export function screenshotVerbFrame(sessionId: string): Record<string, unknown> {
  return { type: "screenshot", sessionId };
}

/** @return the frame bytes as the data URL both the img and the download ride */
export function frameDataUrl(base64: string): string {
  return `data:image/jpeg;base64,${base64}`;
}

/**
 * The screenshot control's file name, off the clock and nothing else.
 *
 * @param epochMs   when the shot was taken
 * @param mediaType what the bytes are — the desktop pane answers PNG, the
 *                  screencast is JPEG; the default keeps the card-226 caller
 */
export function screenshotFilename(epochMs: number, mediaType = "image/jpeg"): string {
  const iso = new Date(epochMs).toISOString(); // 2026-08-14T12:34:56.000Z
  const stamp = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
  return `spectro-browser-${stamp}.${mediaType === "image/png" ? "png" : "jpeg"}`;
}
