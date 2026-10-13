// spectro-desktop/src/serverStart.ts: waiting for the server to come up.
//
// Card 585: a server that exits during start used to cost the whole health
// budget (30 s) and then a dialog that said only "did not become healthy". The
// wait now also watches the child: when it exits, the wait ends at once with
// the server's own last error lines. A server that is alive but slow keeps
// the budget.
import type { ChildProcess } from "node:child_process";

/** Colour and cursor escape codes, as a JVM log prints them. */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** A line that says something went wrong, as Spring Boot and the JVM print it. */
const ERROR_LINE = /\bERROR\b|\bFATAL\b|Exception\b|Error:|^Caused by:|could not|failed/;

/** How long the wait gives the output pipes to drain after the exit. */
const DRAIN_MS = 250;

/** The most characters one kept line holds; the rest of a longer line is dropped. */
const LINE_CAP = 2_000;

/** One line cut to {@link LINE_CAP} characters, marked when it was cut. */
function capped(line: string): string {
  return line.length > LINE_CAP ? `${line.slice(0, LINE_CAP)}…` : line;
}

/** The last lines a child wrote, stdout and stderr together, without colour codes,
 *  bounded by lines and by characters (the unfinished last line included). */
export class OutputTail {
  private readonly lines: string[] = [];
  private partial = "";

  /** @param max how many complete lines to keep */
  constructor(private readonly max = 400) {}

  /** @param chunk one data event from stdout or stderr */
  push(chunk: Buffer | string): void {
    const parts = String(chunk).replace(ANSI, "").split(/\r?\n/);
    const rest = parts.pop() ?? "";
    if (parts.length > 0) {
      // A newline arrived: the unfinished line is complete now.
      this.lines.push(capped(this.partial + parts[0]), ...parts.slice(1).map(capped));
      this.partial = "";
    }
    // An unfinished line grows only up to the cap; the rest of it is dropped.
    if (this.partial.length <= LINE_CAP) this.partial = capped(this.partial + rest);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  /** @returns the kept lines, the unfinished last one included */
  all(): string[] {
    return this.partial === "" ? [...this.lines] : [...this.lines, this.partial];
  }
}

/**
 * The lines that say why a start failed: the description block Spring Boot
 * prints under "APPLICATION FAILED TO START", else the last error lines (no
 * stack frames), else the last lines at all.
 *
 * @param raw the output lines, oldest first
 * @returns up to a few lines joined with newlines, empty when there was no output
 */
export function failureReason(raw: string[]): string {
  const lines = raw.map((line) => line.replace(ANSI, "").trimEnd());
  const description = lines.lastIndexOf("Description:");
  if (description >= 0) {
    const block: string[] = [];
    for (const line of lines.slice(description + 1)) {
      if (line.trim() === "Action:") break;
      if (line.trim() !== "") block.push(line.trim());
    }
    if (block.length > 0) return cap(block.join("\n"));
  }
  const errors = lines.filter((line) => !/^\s+at /.test(line) && ERROR_LINE.test(line.trim()));
  if (errors.length > 0) return cap(errors.slice(-4).join("\n"));
  return cap(
    lines
      .filter((line) => line.trim() !== "")
      .slice(-4)
      .join("\n"),
  );
}

function cap(text: string): string {
  return text.length > 1_200 ? `${text.slice(0, 1_200)}…` : text;
}

/** What the start dialog says about a server that is gone. */
function exitMessage(code: number | null, signal: NodeJS.Signals | null, lines: string[]): string {
  const how = code !== null ? `exit code ${code}` : `signal ${signal ?? "?"}`;
  const reason = failureReason(lines);
  return `spectro-server stopped during start (${how}).` + (reason === "" ? "" : `\n\n${reason}`);
}

/** Everything the wait needs. */
export interface StartWatch {
  /** The server process. */
  child: ChildProcess;
  /** One health question; true when the server answers. */
  probe: () => Promise<boolean>;
  /** The whole budget for a server that stays alive. */
  budgetMs: number;
  /** The gap between two health questions. */
  intervalMs: number;
  /** The server's output, collected since the spawn. */
  tail: OutputTail;
}

/**
 * Waits until the server answers its health probe. Rejects at once with the
 * server's own reason when the process exits first, and with the budget
 * message when a live server never answers.
 *
 * @param watch the child, the probe, the budget and the output
 * @returns resolves when the server is healthy
 */
export function waitForStart(watch: StartWatch): Promise<void> {
  const { child, probe, budgetMs, intervalMs, tail } = watch;
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (error: Error | null): void => {
      if (done) return;
      done = true;
      child.removeListener("exit", onExit);
      if (error === null) resolve();
      else reject(error);
    };
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      // The last lines can still be in the pipes when "exit" fires: give them
      // a moment, or until the streams close, whichever is first.
      const report = (): void => finish(new Error(exitMessage(code, signal, tail.all())));
      const timer = setTimeout(report, DRAIN_MS);
      child.once("close", () => {
        clearTimeout(timer);
        report();
      });
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
      return;
    }
    child.once("exit", onExit);

    const deadline = Date.now() + budgetMs;
    void (async () => {
      while (!done && Date.now() < deadline) {
        if (await probe().catch(() => false)) {
          finish(null);
          return;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      finish(new Error(`spectro-server did not become healthy within ${budgetMs / 1000} s.`));
    })();
  });
}
