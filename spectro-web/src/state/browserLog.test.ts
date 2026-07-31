// The client ring (the browser half of the log pane). These pins are the
// guarantees the module exists for: it stays bounded under a render loop, it
// cannot recurse when it is the thing that broke, and nothing personal reaches
// the pane — the user pastes this into an issue.
//
// The suite runs in plain Node (no jsdom), so the global handlers are driven
// through an injected event target instead of a real window.

import { beforeEach, describe, expect, it } from "vitest";
import { mergeRows, rowText, serverBlocks } from "../components/LogPane";
import {
  __resetForTests,
  __setTestHooks,
  BROWSER_LOG_CAPACITY,
  BROWSER_LOG_MAX_ENTRIES,
  browserLogEntries,
  installBrowserLog,
  logBrowser,
  reportBrowserError,
  type BrowserLogEntry,
} from "./browserLog";

let clock = 0;

beforeEach(() => {
  clock = 1_000;
  __setTestHooks({ now: () => clock });
  __resetForTests();
});

function fakeTarget() {
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  return {
    addEventListener(type: string, listener: (event: unknown) => void): void {
      handlers.set(type, [...(handlers.get(type) ?? []), listener]);
    },
    removeEventListener(type: string, listener: (event: unknown) => void): void {
      handlers.set(
        type,
        (handlers.get(type) ?? []).filter((l) => l !== listener),
      );
    },
    dispatch(type: string, event: unknown): void {
      for (const l of [...(handlers.get(type) ?? [])]) l(event);
    },
    count(type: string): number {
      return (handlers.get(type) ?? []).length;
    },
  };
}

const last = (): BrowserLogEntry => {
  const all = browserLogEntries();
  return all[all.length - 1];
};

describe("browserLog ring", () => {
  it("stays bounded and drops the oldest entry", () => {
    for (let i = 0; i < BROWSER_LOG_CAPACITY + 40; i++) logBrowser("info", "test", `m${i}`);
    const entries = browserLogEntries();
    expect(entries.length).toBe(BROWSER_LOG_CAPACITY);
    expect(entries[0].message).toBe("m40");
    expect(last().message).toBe(`m${BROWSER_LOG_CAPACITY + 39}`);
  });

  it("stamps a non-decreasing timestamp even when the wall clock steps back", () => {
    clock = 5_000;
    logBrowser("info", "test", "one");
    clock = 4_000;
    logBrowser("info", "test", "two");
    const [a, b] = browserLogEntries();
    expect(a.at).toBe(5_000);
    expect(b.at).toBeGreaterThanOrEqual(a.at);
  });

  it("publishes a new snapshot per accepted entry and a stable one otherwise", () => {
    const before = browserLogEntries();
    logBrowser("info", "test", "one");
    expect(browserLogEntries()).not.toBe(before);
    expect(browserLogEntries()).toBe(browserLogEntries());
  });

  it("collapses a repeating message into one entry with a count", () => {
    for (let i = 0; i < 5; i++) logBrowser("error", "render", "boom");
    expect(browserLogEntries().length).toBe(1);
    expect(last().count).toBe(5);

    clock = 9_000;
    logBrowser("error", "render", "boom");
    expect(browserLogEntries().length).toBe(1);
    expect(last().count).toBe(6);
    expect(last().at).toBe(9_000);

    logBrowser("error", "render", "different");
    expect(browserLogEntries().length).toBe(2);
    expect(last().count).toBe(1);
  });

  it("stops accepting entries at the per-page-load cap and says so once", () => {
    for (let i = 0; i < BROWSER_LOG_MAX_ENTRIES + 20; i++) logBrowser("info", "flood", `m${i}`);
    const capped = last();
    expect(capped.level).toBe("warn");
    expect(capped.message).toContain("capped");

    const frozen = browserLogEntries();
    logBrowser("error", "later", "after the cap");
    expect(browserLogEntries()).toBe(frozen);
    expect(frozen.some((e) => e.message === "after the cap")).toBe(false);
  });
});

describe("browserLog global handlers", () => {
  it("installs once and removes cleanly", () => {
    const target = fakeTarget();
    const off = installBrowserLog(target);
    const offAgain = installBrowserLog(target);
    expect(target.count("error")).toBe(1);
    expect(target.count("unhandledrejection")).toBe(1);

    target.dispatch("error", { error: new Error("live") });
    expect(browserLogEntries().length).toBe(1);

    off();
    offAgain();
    expect(target.count("error")).toBe(0);
    target.dispatch("error", { error: new Error("dead") });
    expect(browserLogEntries().length).toBe(1);
  });

  it("cannot recurse when reporting re-enters the handler", () => {
    const target = fakeTarget();
    installBrowserLog(target);
    // A hostile error that fires a second error event WHILE it is being read —
    // the shape of "the reporter is what broke". Without the re-entrancy flag
    // this recurses until the stack blows.
    class Hostile extends Error {
      override get name(): string {
        target.dispatch("error", { error: this });
        return "Hostile";
      }
    }
    expect(() => target.dispatch("error", { error: new Hostile("boom") })).not.toThrow();
    expect(browserLogEntries().length).toBe(1);
  });

  it("swallows a handler body that throws instead of escaping into the page", () => {
    const target = fakeTarget();
    installBrowserLog(target);
    const bad = new Error("x");
    Object.defineProperty(bad, "message", {
      get(): string {
        throw new Error("cannot read me");
      },
    });
    expect(() => target.dispatch("error", { error: bad })).not.toThrow();
    expect(browserLogEntries().length).toBeLessThanOrEqual(1);
  });
});

describe("browserLog privacy", () => {
  it("rewrites home directories in the stack and keeps only name plus message", () => {
    const err = new Error("boom");
    err.stack = [
      "Error: boom",
      "    at go (/Users/christopher.ezell/Spectroscope/app.ts:3:9)",
      "    at run (file:///home/ada/x.js:1:1)",
      "    at win (C:\\Users\\ada\\proj\\y.js:2:2)",
    ].join("\n");
    reportBrowserError("import", err);

    const entry = last();
    expect(entry.message).toBe("Error: boom");
    expect(entry.source).toBe("import");
    expect(entry.detail).toContain("~/Spectroscope/app.ts:3:9");
    expect(entry.detail).not.toContain("christopher.ezell");
    expect(entry.detail).not.toContain("ada");
  });

  it("caps a runaway message", () => {
    reportBrowserError("import", new Error("y".repeat(5_000)));
    expect(last().message.length).toBeLessThan(400);
  });

  it("never captures the filename or line of an error event", () => {
    const target = fakeTarget();
    installBrowserLog(target);
    target.dispatch("error", {
      message: "Script error.",
      filename: "http://localhost:8080/assets/secret-chunk.js",
      lineno: 4,
      colno: 2,
      error: new Error("boom"),
    });
    expect(JSON.stringify(last())).not.toContain("secret-chunk");
  });

  it("stays honest about a rejection that carries no message", () => {
    const target = fakeTarget();
    installBrowserLog(target);
    target.dispatch("unhandledrejection", { reason: { token: "sk-live-123" } });

    const entry = last();
    expect(entry.level).toBe("error");
    expect(JSON.stringify(entry)).not.toContain("sk-live-123");
    expect(entry.message).toContain("object");
  });
});

// The pane's half of the deal: the two streams interleave by time without the
// server's own multi-line records coming apart.
describe("log pane merge", () => {
  const SERVER = [
    "2026-07-27 10:00:00.100 INFO  d.s.Boot - up",
    "2026-07-27 10:00:02.000 ERROR d.s.Ws - broke",
    "java.lang.RuntimeException: nope",
    "\tat dev.spectroscope.Ws.run(Ws.java:1)",
  ].join("\n");

  it("keeps a stack trace attached to the line it belongs to", () => {
    const blocks = serverBlocks(SERVER);
    expect(blocks.length).toBe(2);
    expect(blocks[1].lines.length).toBe(3);
    expect(blocks[0].at).toBeLessThan(blocks[1].at);
  });

  it("slots a browser entry between the server lines it happened between", () => {
    clock = Date.parse("2026-07-27T10:00:01.000");
    logBrowser("error", "import", "unreadable session file");

    const rows = mergeRows(serverBlocks(SERVER), browserLogEntries());
    expect(rows.map((r) => r.kind)).toEqual(["server", "browser", "server"]);
    expect(rows[2].kind === "server" && rows[2].block.lines.length).toBe(3);
  });

  it("leaves a fragment from a rolled file at the top rather than dating it", () => {
    clock = Date.parse("2026-07-27T09:00:00.000");
    logBrowser("info", "import", "earlier than the whole file");

    const rows = mergeRows(serverBlocks(`ntinued from a rolled file\n${SERVER}`), browserLogEntries());
    expect(rows[0].kind).toBe("server");
    expect(rows[1].kind).toBe("browser");
  });

  it("copies a browser row as its head plus indented detail", () => {
    clock = Date.parse("2026-07-27T10:00:01.000");
    logBrowser("warn", "import", "twice", "at go (~/app.ts:1:1)");
    logBrowser("warn", "import", "twice", "at go (~/app.ts:1:1)");

    const rows = mergeRows([], browserLogEntries());
    expect(rowText(rows[0])).toBe(
      "2026-07-27 10:00:01.000 WARN browser [import] twice ×2\n    at go (~/app.ts:1:1)",
    );
  });
});
