// Card 473: the wires an imported session holds in the browser.
//
// A stored session's wires live on the server, and three readers ask for them
// by session id: the trace's merge (the llm-wire index), the open exchange
// pane (one exchange) and the browser replay (the browser-wire index and one
// action). An imported session has no server id, so until card 473 every one
// of those asks answered "nothing". Now the import reads the wire files it
// was given into this registry under its own session id, and the fetch
// functions in llmWire.ts and browserWire.ts look here first.
//
// The index rows are built by the SAME rules as the server's endpoints
// (LlmWireIndex.java, BrowserWireController.java), and heldWire.test.ts holds
// them to the server's captured answers for one real recorded file.
//
// Only the import on screen holds anything: a new import releases the last
// one, so a 50 MB wire does not outlive the session it belongs to.

/** One held llm wire: the server-shaped index rows, and each exchange's two
 *  raw lines, parsed only when a reader opens that exchange. */
export interface HeldLlmWire {
  index: Record<string, unknown>[];
  pairs: Map<string, { request: string; response: string | null }>;
}

/** One held browser wire, shaped the same way, keyed by the call id. */
export interface HeldBrowserWire {
  index: Record<string, unknown>[];
  pairs: Map<string, { call: string; result: string | null }>;
}

export interface HeldWires {
  llm?: HeldLlmWire;
  browser?: HeldBrowserWire;
}

const held = new Map<string, HeldWires>();

/**
 * Holds the wires of one imported session, releasing whatever was held
 * before: only the import on screen keeps its wires.
 *
 * @param sessionId the import's session id (the replay id)
 * @param wires     what was read
 */
export function holdWires(sessionId: string, wires: HeldWires): void {
  held.clear();
  held.set(sessionId, wires);
}

/** Lets go of every held wire. */
export function releaseHeldWires(): void {
  held.clear();
}

/** The held llm wire of a session, or null when it holds none. */
export function heldLlmWire(sessionId: string): HeldLlmWire | null {
  return held.get(sessionId)?.llm ?? null;
}

/** The held browser wire of a session, or null when it holds none. */
export function heldBrowserWire(sessionId: string): HeldBrowserWire | null {
  return held.get(sessionId)?.browser ?? null;
}

/** How a long read shares the thread: a slice budget, a progress report, and
 *  a way to stop when a later navigation has taken over. */
export interface ReadOptions {
  /** Called after each slice with the characters read so far and the total. */
  onProgress?: (done: number, total: number) => void;
  /** Checked between slices; false stops the read and it answers null. */
  isCurrent?: () => boolean;
  /** How long one slice may hold the thread, in milliseconds. Default 12. */
  sliceMs?: number;
  /** The clock; performance.now unless a test moves it by hand. */
  now?: () => number;
}

/** Characters read between two looks at the clock, at most (one line more). */
const CLOCK_EVERY_CHARS = 64 * 1024;

const yieldToTheBrowser = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Walks the lines of a wire in slices, handing each parsed object to `take`.
 * A line ends at LF and at CR, as the server's reader ends one; a line that
 * does not parse or is no object is skipped, as the server skips a torn tail.
 *
 * @return false when the read was superseded, true when it reached the end
 */
async function eachLine(
  text: string,
  take: (node: Record<string, unknown>, line: string) => void,
  options: ReadOptions,
): Promise<boolean> {
  const budget = options.sliceMs ?? 12;
  const now = options.now ?? (() => performance.now());
  let at = 0;
  // The next CR and LF at or after `at`, each searched again only once `at`
  // has passed it: a file without a single CR would otherwise be scanned to
  // its end once per line.
  let lf = -2;
  let cr = -2;
  while (at < text.length) {
    if (options.isCurrent !== undefined && !options.isCurrent()) return false;
    const started = now();
    while (at < text.length && now() - started < budget) {
      // The clock is read every 256 lines or every 64 KB, whichever comes
      // first: it is not free, and a request line can carry a whole
      // conversation, so a count of lines alone let one slice parse
      // megabytes.
      const from = at;
      for (let n = 0; n < 256 && at < text.length && at - from < CLOCK_EVERY_CHARS; n++) {
        if (lf !== -1 && lf < at) lf = text.indexOf("\n", at);
        if (cr !== -1 && cr < at) cr = text.indexOf("\r", at);
        const stop = lf === -1 ? (cr === -1 ? text.length : cr) : cr === -1 ? lf : Math.min(lf, cr);
        const line = text.slice(at, stop);
        at = stop + 1;
        if (line === "") continue;
        let node: unknown;
        try {
          node = JSON.parse(line);
        } catch {
          continue; // a torn line carries nothing, here as on the server
        }
        if (typeof node === "object" && node !== null && !Array.isArray(node)) {
          take(node as Record<string, unknown>, line);
        }
      }
    }
    if (at > text.length) at = text.length;
    options.onProgress?.(at, text.length);
    if (at < text.length) await yieldToTheBrowser();
  }
  return true;
}

const textOrNull = (node: Record<string, unknown>, field: string): string | null => {
  const v = node[field];
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : JSON.stringify(v);
};
const intOrNull = (node: Record<string, unknown>, field: string): number | null =>
  typeof node[field] === "number" ? Math.trunc(node[field]) : null;
const intOr = (node: Record<string, unknown>, field: string, fallback: number): number =>
  typeof node[field] === "number" ? Math.trunc(node[field]) : fallback;
const textOf = (node: Record<string, unknown>, field: string): string =>
  typeof node[field] === "string"
    ? node[field]
    : node[field] === undefined || node[field] === null
      ? ""
      : String(node[field]);

/**
 * Reads an llm wire into its index and its exchange pairs.
 *
 * @param text    the whole .llm.jsonl file
 * @param options slicing, progress and supersession
 * @return the held wire, or null when a later navigation stopped the read
 */
export async function readLlmWire(text: string, options: ReadOptions = {}): Promise<HeldLlmWire | null> {
  const entries = new Map<string, Record<string, unknown>>();
  const pairs = new Map<string, { request: string; response: string | null }>();
  const done = await eachLine(
    text,
    (node, line) => {
      const xid = textOf(node, "xid");
      switch (node.type) {
        case "llm_request":
          // Same as LlmWireIndex.openEntry: every frame field, the response
          // half at its unanswered defaults.
          entries.set(xid, {
            xid,
            agentId: textOrNull(node, "agentId"),
            turn: intOrNull(node, "turn"),
            kind: textOrNull(node, "kind"),
            provider: textOrNull(node, "provider"),
            model: textOrNull(node, "model"),
            transport: textOrNull(node, "transport"),
            url: textOrNull(node, "url"),
            status: null,
            requestBytes: intOr(node, "bodyBytes", 0),
            responseBytes: 0,
            responseLines: 0,
            aborted: false,
            fidelity: textOrNull(node, "fidelity"),
            durationMs: null,
            ts: intOr(node, "ts", 0),
          });
          // The exchange endpoint answers the FIRST request line of an xid.
          if (!pairs.has(xid)) pairs.set(xid, { request: line, response: null });
          break;
        case "llm_response": {
          const entry = entries.get(xid);
          if (entry !== undefined) {
            entry.status = intOrNull(node, "status");
            entry.responseBytes = intOr(node, "bodyBytes", 0);
            entry.responseLines = Array.isArray(node.lines) ? node.lines.length : intOr(node, "lineCount", 0);
            entry.aborted = node.aborted === true;
            entry.durationMs = intOrNull(node, "durationMs");
            entry.ts = intOr(node, "ts", 0);
          }
          const pair = pairs.get(xid);
          if (pair !== undefined && pair.response === null) pair.response = line;
          break;
        }
        default:
          break; // the truncation marker carries no exchange
      }
    },
    options,
  );
  return done ? { index: [...entries.values()], pairs } : null;
}

/**
 * Reads a browser wire into its index and its call pairs.
 *
 * @param text    the whole .browser.jsonl file
 * @param options slicing, progress and supersession
 * @return the held wire, or null when a later navigation stopped the read
 */
export async function readBrowserWire(
  text: string,
  options: ReadOptions = {},
): Promise<HeldBrowserWire | null> {
  const entries = new Map<string, Record<string, unknown>>();
  const pairs = new Map<string, { call: string; result: string | null }>();
  const done = await eachLine(
    text,
    (node, line) => {
      const cid = textOf(node, "cid");
      switch (node.type) {
        case "browser_call":
          // Same as BrowserWireController.openEntry.
          entries.set(cid, {
            cid,
            epoch: intOr(node, "epoch", 0),
            agentId: textOrNull(node, "agentId"),
            callId: textOrNull(node, "callId"),
            actor: textOrNull(node, "actor"),
            tool: textOrNull(node, "tool"),
            pageUrl: textOrNull(node, "pageUrl"),
            ok: null,
            resultBytes: 0,
            durationMs: null,
            blobPath: null,
            sha256: null,
            mediaType: null,
            width: 0,
            height: 0,
            ts: intOr(node, "ts", 0),
            startedAt: intOr(node, "ts", 0),
          });
          if (!pairs.has(cid)) pairs.set(cid, { call: line, result: null });
          break;
        case "browser_result": {
          const entry = entries.get(cid);
          if (entry !== undefined) {
            entry.ok = node.ok === true;
            entry.resultBytes = intOr(node, "resultBytes", 0);
            entry.durationMs = intOrNull(node, "durationMs");
            if (node.pageUrl !== undefined && node.pageUrl !== null)
              entry.pageUrl = textOrNull(node, "pageUrl");
            const image = node.image;
            if (typeof image === "object" && image !== null && !Array.isArray(image)) {
              const img = image as Record<string, unknown>;
              entry.blobPath = textOrNull(img, "blobPath");
              entry.sha256 = textOrNull(img, "sha256");
              entry.mediaType = textOrNull(img, "mediaType");
              entry.width = intOr(img, "width", 0);
              entry.height = intOr(img, "height", 0);
            }
            entry.ts = intOr(node, "ts", 0);
          }
          const pair = pairs.get(cid);
          if (pair !== undefined && pair.result === null) pair.result = line;
          break;
        }
        default:
          break; // the open and ceiling markers carry no action
      }
    },
    options,
  );
  return done ? { index: [...entries.values()], pairs } : null;
}

/** Exchange and call ids as the recorders mint them; the server refuses any
 *  other shape before it reads a byte, and so does this registry. */
export const RECORDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
