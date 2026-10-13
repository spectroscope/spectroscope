import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { failureReason, OutputTail, waitForStart } from "./serverStart";

// Card 585: the owner set SPECTRO_HUB_PORT=1, the server died in its first
// second, and the app waited the whole 30 s health budget and then said only
// "did not become healthy". A server that exits during start is now named at
// once, with its own last error lines; a server that is alive but slow keeps
// the budget.

const children: ChildProcess[] = [];

/** A node child running a one-line script, its output collected in a tail. */
function child(script: string): { proc: ChildProcess; tail: OutputTail } {
  const proc = spawn(process.execPath, ["-e", script]);
  children.push(proc);
  const tail = new OutputTail();
  proc.stdout?.on("data", (chunk: Buffer) => tail.push(chunk));
  proc.stderr?.on("data", (chunk: Buffer) => tail.push(chunk));
  return { proc, tail };
}

afterEach(() => {
  for (const proc of children.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
});

const never = async (): Promise<boolean> => false;

describe("waitForStart", () => {
  it("names the server's own reason within a second when it exits at once", async () => {
    const { proc, tail } = child(
      "console.log('Starting spectro-server');" +
        "console.error('\\u001b[31mERROR\\u001b[0m Application run failed');" +
        "console.error('Caused by: java.net.BindException: Permission denied');" +
        "process.exit(1)",
    );
    const started = Date.now();
    await assert.rejects(
      waitForStart({ child: proc, probe: never, budgetMs: 3_000, intervalMs: 100, tail }),
      (err: Error) => {
        assert.match(err.message, /Permission denied/);
        assert.match(err.message, /exit code 1/);
        assert.doesNotMatch(err.message, /\u001b\[/, "no colour codes in a dialog");
        assert.doesNotMatch(err.message, /did not become healthy/);
        return true;
      },
    );
    const waited = Date.now() - started;
    assert.ok(waited < 1_000, `the reason came after ${waited} ms`);
  });

  it("keeps the whole budget for a server that is alive but slow", async () => {
    const { proc, tail } = child("setTimeout(() => {}, 10000)");
    const started = Date.now();
    await assert.rejects(
      waitForStart({ child: proc, probe: never, budgetMs: 800, intervalMs: 100, tail }),
      /did not become healthy within 0.8 s/,
    );
    const waited = Date.now() - started;
    assert.ok(waited >= 750, `gave up after ${waited} ms of an 800 ms budget`);
    assert.equal(proc.exitCode, null, "the slow child was not killed by the wait");
  });

  it("returns as soon as the server answers", async () => {
    const { proc, tail } = child("setTimeout(() => {}, 10000)");
    let asked = 0;
    await waitForStart({ child: proc, probe: async () => ++asked >= 3, budgetMs: 5_000, intervalMs: 50, tail });
    assert.equal(asked, 3);
  });
});

describe("failureReason", () => {
  it("takes the description Spring prints when the application fails to start", () => {
    // Spring logs an ERROR line just before the block; the block is the reason.
    const lines = [
      "2026-10-13 INFO starting",
      "2026-10-13 ERROR [main] o.s.b.d.LoggingFailureAnalysisReporter:",
      "",
      "***************************",
      "APPLICATION FAILED TO START",
      "***************************",
      "",
      "Description:",
      "",
      "Web server failed to start. Port 7745 was already in use.",
      "",
      "Action:",
      "",
      "Identify and stop the process that's listening on port 7745.",
    ];
    assert.equal(failureReason(lines), "Web server failed to start. Port 7745 was already in use.");
  });

  it("falls back to the last error lines, without colour codes", () => {
    const lines = [
      "INFO one",
      "\u001b[31mERROR\u001b[0m Application run failed",
      "java.lang.IllegalStateException: boom",
      "\tat a.b.C.d(C.java:1)",
      "Caused by: java.io.UncheckedIOException: SPECTRO_HUB_PORT=1 could not bind",
      "\tat a.b.C.e(C.java:2)",
    ];
    const reason = failureReason(lines);
    assert.match(reason, /could not bind/);
    assert.match(reason, /Application run failed/);
    assert.doesNotMatch(reason, /\tat /, "no stack frames");
    assert.doesNotMatch(reason, /\u001b/);
  });

  it("says the last lines when nothing looks like an error", () => {
    assert.equal(failureReason(["a", "", "b", "c"]), "a\nb\nc");
    assert.equal(failureReason([]), "");
  });
});

describe("OutputTail", () => {
  // Review N1: the tail is bounded by lines and by characters, the unfinished
  // last line included, so a server that prints a megabyte without a newline
  // cannot fill the shell's memory.
  it("keeps only the last lines", () => {
    const tail = new OutputTail();
    for (let i = 0; i < 1_000; i++) tail.push(`line ${i}\n`);
    const kept = tail.all();
    assert.equal(kept.length, 400);
    assert.equal(kept[0], "line 600");
    assert.equal(kept[399], "line 999");
  });

  it("caps a long line and an unfinished one", () => {
    const unfinished = new OutputTail();
    unfinished.push("x".repeat(10 * 1024 * 1024));
    unfinished.push("x".repeat(1024));
    assert.ok(unfinished.all()[0].length <= 2_001, `kept ${unfinished.all()[0].length} characters`);

    const long = new OutputTail();
    for (let i = 0; i < 400; i++) long.push("y".repeat(100_000) + "\n");
    const total = long.all().reduce((sum, line) => sum + line.length, 0);
    assert.ok(total <= 400 * 2_001, `kept ${total} characters`);
  });
});
