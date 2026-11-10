// Card 604: the digest a model reads, built from the ledger in the browser.
// It is the exact text the consent sheet shows and the click sends: a header
// with the workspace, one line per file call, and a shell call's output cut to
// a bound. What write_file and edit_file wrote never appears, because the call
// line names the path only. Section 3 of the design is the authority.

import type { FileCall, FileLedger } from "./fold";

/** The server's bound on a digest, AnalyzeController.MAX_DIGEST_CHARS. */
export const FILES_DIGEST_MAX = 60_000;
/** The most of one shell output the digest carries. */
export const OUTPUT_MAX = 2_000;

export interface FilesDigest {
  text: string;
  /** The bound cut outputs or dropped calls. */
  truncated: boolean;
  /** The calls the text names. */
  calls: number;
}

const OUTPUT = "  output: ";
const CUT = `${OUTPUT}[cut]`;

interface Entry {
  line: string;
  output: string | null; // the whole output line, or null when the call has none
}

/**
 * The digest of a ledger. Over FILES_DIGEST_MAX, outputs are replaced by
 * `[cut]` from the oldest call on; when that is not enough, the oldest call
 * lines go and the header says how many.
 */
export function buildFilesDigest(ledger: FileLedger): FilesDigest {
  const entries = ledger.calls.map(entryOf);
  const workspace = `workspace: ${ledger.workspace ?? "unknown"}`;
  // Every line ends in a newline except the last, so a line costs its length plus one.
  let size = workspace.length;
  for (const e of entries) size += e.line.length + 1 + (e.output === null ? 0 : e.output.length + 1);

  let truncated = false;
  for (let i = 0; i < entries.length && size > FILES_DIGEST_MAX; i++) {
    const output = entries[i].output;
    if (output === null || output === CUT) continue;
    size -= output.length - CUT.length;
    entries[i] = { ...entries[i], output: CUT };
    truncated = true;
  }

  let dropped = 0;
  let header = workspace;
  while (dropped < entries.length && size - workspace.length + header.length > FILES_DIGEST_MAX) {
    const e = entries[dropped++];
    size -= e.line.length + 1 + (e.output === null ? 0 : e.output.length + 1);
    header = `${workspace} (${dropped === 1 ? "the oldest call is" : `the oldest ${dropped} calls are`} left out)`;
    truncated = true;
  }

  const lines = [header];
  for (const e of entries.slice(dropped)) {
    lines.push(e.line);
    if (e.output !== null) lines.push(e.output);
  }
  return { text: lines.join("\n"), truncated, calls: entries.length - dropped };
}

function entryOf(call: FileCall): Entry {
  const seconds = call.t === null ? "?" : call.t.toFixed(1);
  const line = `#${call.callIndex} ${seconds}s ${call.agentId} ${call.tool}: ${call.line}`;
  if (!call.shell || call.output === null || call.output === "") return { line, output: null };
  const flat = oneLine(call.output);
  const cut = flat.length > OUTPUT_MAX;
  return { line, output: `${OUTPUT}${cut ? `${flat.slice(0, OUTPUT_MAX)} [cut]` : flat}` };
}

/** Line breaks as the fold writes them in a command line, so one output stays one line. */
const oneLine = (text: string) => text.replace(/\r\n|\r|\n/g, " ⏎ ");
