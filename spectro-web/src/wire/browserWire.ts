// The browser record, as this page sees it (card 204).
//
// The server writes every browser tool call beside the session
// (~/.spectro/browser-wire/<id>.browser.jsonl) and serves it back through one
// gated, loopback-fenced endpoint per session — the llm-wire's arrangement,
// because the two files are the same kind of thing: a trace too big and too
// detailed to live in the byte-frozen RunEvent wire.
//
// What is here is the READ side and nothing else. Four pure functions and two
// fetches:
//   - the ledger row read into a typed record, tolerantly, the way llmWire.ts
//     reads an exchange,
//   - the one-line summary a scrubber step shows, built from NOTHING but that
//     record, so it structurally cannot print a page's text,
//   - the screenshot's URL, built from the blob's BASENAME only,
//   - the cut into epochs, which is the part that would be easy to skip.
//
// WHY THE EPOCHS. A session can outlive its browser: closing the session retires
// it and a resume opens a fresh one, with fresh cookies, appending to the same
// file (card 218). A scrubber that ran straight through would show a logged-in
// page turning into a logged-out one with no explanation, and would be telling
// one story about two browsers.
//
// LIVE FRAMES ARE NOT HERE, on purpose. What the operator watches live is a
// native WebContentsView the shell lays over the window; those pixels are not
// events, never enter the JSONL, and there is nothing in this module that could
// carry them. The replay is built out of the sidecar and the image store, which
// is exactly what the card asks: "loading exactly the sidecar and the blobs its
// events reference, nothing else".

/** One recorded browser action, as the ledger endpoint spells it. Metadata
 *  only — the arguments and the result text live behind {@link fetchBrowserAction}. */
export interface BrowserActionMeta {
  /** The record's own id: the drill-in's key, and what a `browser_action`
   *  event in the session carries so a row can find its two lines. */
  cid: string;
  /** Which browser of the session's life this drove. 1-based; 0 when the run
   *  had no recorder at all. */
  epoch: number;
  agentId: string;
  /** The provider's tool_use id, so a step can be tied back to the transcript. */
  callId: string;
  /** The wire name: browser_navigate, browser_eval, browser_computer, … */
  tool: string;
  /** The address the call ended on, or "" when no page was open. May be a
   *  redaction marker rather than a URL — the writer replaces a
   *  credential-shaped address whole. */
  pageUrl: string;
  ok: boolean;
  resultBytes: number;
  durationMs: number;
  /** The screenshot blob, relative to ~/.spectro; "" for a call that took none. */
  blobPath: string;
  sha256: string;
  mediaType: string;
  width: number;
  height: number;
  /** When the call ended. */
  ts: number;
  /** When it started — the order a replay walks, since a slow navigate can
   *  finish after a later call started. */
  startedAt: number;
}

/** One browser's life inside a session: its number and its steps, in order. */
export interface ReplayEpoch {
  epoch: number;
  steps: readonly BrowserActionMeta[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * One ledger row read into a record, tolerantly: every field except the two the
 * record cannot exist without is defaulted, so an older or newer server
 * degrades a cell rather than dropping a step out of the replay.
 *
 * @param value one row of the ledger
 * @return the record, or null for a row without a cid (nothing to drill into)
 *         or without a ts (no place on the scrubber)
 */
export function readBrowserAction(value: unknown): BrowserActionMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.cid !== "string" || v.cid === "" || typeof v.ts !== "number") return null;
  return {
    cid: v.cid,
    epoch: num(v.epoch),
    agentId: str(v.agentId),
    callId: str(v.callId),
    tool: str(v.tool),
    pageUrl: str(v.pageUrl),
    ok: v.ok === true,
    resultBytes: num(v.resultBytes),
    durationMs: num(v.durationMs),
    blobPath: str(v.blobPath),
    sha256: str(v.sha256),
    mediaType: str(v.mediaType),
    width: num(v.width),
    height: num(v.height),
    ts: v.ts,
    startedAt: typeof v.startedAt === "number" ? v.startedAt : v.ts,
  };
}

/** The host a reader recognises, or the whole string when it does not parse —
 *  a recorded address can be a redaction marker, and half a guess would be a
 *  claim about something that was deliberately not recorded. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The step's one line: what was done, where, and how it went. Built from the
 * meta record alone, so it structurally cannot print a page's own text.
 *
 * @param step the ledger record
 * @return the summary line
 */
export function browserStepSummary(step: BrowserActionMeta): string {
  const where = step.pageUrl === "" ? "no page" : hostOf(step.pageUrl);
  const outcome = step.ok ? `${step.durationMs} ms` : `failed · ${step.durationMs} ms`;
  return `${step.tool} · ${where} · ${outcome}`;
}

/**
 * Whether this step left a picture to show.
 *
 * @param step the ledger record
 * @return true when a blob was recorded for it
 */
export function hasScreenshot(step: BrowserActionMeta): boolean {
  return step.blobPath !== "" && step.sha256 !== "";
}

/**
 * Where the recorded screenshot loads from.
 *
 * <p>The BASENAME only, never the recorded path. `blobPath` is text out of a
 * file on disk; handing it to a URL whole would let a record containing
 * `../../` address the server with a path of its own choosing. The image
 * endpoint takes a file name and jails it on its own side too — this is the
 * near half of that fence, on the side that builds the request.
 *
 * @param step the ledger record
 * @return the URL, or null when the step recorded no picture
 */
export function screenshotUrl(step: BrowserActionMeta): string | null {
  if (step.blobPath === "") return null;
  const name = step.blobPath.split("/").pop() ?? "";
  return name === "" ? null : `/api/images/${encodeURIComponent(name)}`;
}

/**
 * The trace cut into browsers.
 *
 * @param steps the ledger, in whatever order it arrived
 * @return one entry per browser the session had, each with its steps in the
 *         order they STARTED — a slow navigate can finish after a later call
 *         began, and the scrubber walks what happened, not what finished
 */
export function replayEpochs(steps: readonly BrowserActionMeta[]): ReplayEpoch[] {
  const byEpoch = new Map<number, BrowserActionMeta[]>();
  for (const step of steps) {
    const bucket = byEpoch.get(step.epoch);
    if (bucket === undefined) byEpoch.set(step.epoch, [step]);
    else bucket.push(step);
  }
  return [...byEpoch.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([epoch, list]) => ({
      epoch,
      steps: [...list].sort((a, b) => a.startedAt - b.startedAt),
    }));
}

/**
 * One session's recorded browser actions. An empty array for every way of
 * having none — no sidecar, an older server, a network miss — because the
 * caller's next move is the same in all three: show the empty state.
 *
 * @param sessionId whose record to read
 * @return the ledger, oldest first
 */
export async function fetchBrowserWireIndex(sessionId: string): Promise<BrowserActionMeta[]> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/browser-wire/index`);
    if (!res.ok) return [];
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.map(readBrowserAction).filter((x): x is BrowserActionMeta => x !== null);
  } catch {
    return [];
  }
}

/** One action's two recorded lines: what the model asked for and what it read
 *  back. The credential-shaped strings were already replaced by the writer, so
 *  what arrives here is safe to paint. */
export interface BrowserActionDetail {
  /** The arguments as the model wrote them, with credential-shaped strings
   *  already swapped for `{kind:"redacted",rule,bytes}` markers by the writer. */
  input: unknown;
  /** The tool result exactly as the model read it, or null when the writer
   *  redacted or dropped it. */
  result: string | null;
  /** Why the result is absent: the redaction rule that fired, "ceiling" when
   *  the recorder hit its size limit, or "" when it is simply still open. */
  omitted: string;
  ok: boolean;
}

/**
 * Reads the drill-in answer. Exported for the component's test seam.
 *
 * @param value the endpoint's answer
 * @return the detail, or null when the answer is not even that shape
 */
export function readBrowserActionDetail(value: unknown): BrowserActionDetail | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const call = (typeof v.call === "object" && v.call !== null ? v.call : null) as Record<
    string,
    unknown
  > | null;
  if (call === null) return null;
  const result = (typeof v.result === "object" && v.result !== null ? v.result : null) as Record<
    string,
    unknown
  > | null;
  const redacted = result?.resultRedacted as { rule?: unknown } | undefined;
  return {
    input: call.input ?? null,
    result: typeof result?.result === "string" ? result.result : null,
    omitted:
      typeof result?.omitted === "string"
        ? result.omitted
        : typeof redacted?.rule === "string"
          ? redacted.rule
          : "",
    ok: result?.ok === true,
  };
}

/**
 * One action's arguments and result, on the gesture that asks for them.
 *
 * @param sessionId whose record to read
 * @param cid       the action's id
 * @return the detail, or null on any refusal — the pane says an honest sentence
 */
export async function fetchBrowserAction(
  sessionId: string,
  cid: string,
): Promise<BrowserActionDetail | null> {
  try {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/browser-wire/action/${encodeURIComponent(cid)}`,
    );
    if (!res.ok) return null;
    return readBrowserActionDetail((await res.json()) as unknown);
  } catch {
    return null;
  }
}
