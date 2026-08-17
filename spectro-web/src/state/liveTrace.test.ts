// Card 246: the live-trace switch. The store half follows density.ts (the
// injectable-storage idiom, because this suite runs in plain Node); the
// consumer half is pinned off the source, because a store nobody consults
// ships dead (the sessionRowDensity lesson). The fold half — what "off"
// does to a UiState — lives in reducer.test.ts beside the other folds.

import { beforeEach, describe, expect, it } from "vitest";
import {
  LIVE_TRACE_KEY,
  __resetForTests,
  __setTestHooks,
  currentLiveTraceWanted,
  readLiveTraceWanted,
  setLiveTraceWanted,
} from "./liveTrace";
import { read, stripComments } from "../testkit/source";

describe("the live-trace store", () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    __setTestHooks({
      get: (k) => store[k] ?? null,
      set: (k, v) => {
        store[k] = v;
      },
    });
    __resetForTests();
  });

  it("defaults to ON — today's behaviour is the default", () => {
    expect(readLiveTraceWanted()).toBe(true);
    expect(currentLiveTraceWanted()).toBe(true);
  });

  it("persists OFF under the house key and reads it back", () => {
    setLiveTraceWanted(false);
    expect(store[LIVE_TRACE_KEY]).toBe("off");
    expect(currentLiveTraceWanted()).toBe(false);
    __resetForTests();
    expect(currentLiveTraceWanted()).toBe(false);
  });

  it("turning it back on restores the default shape", () => {
    setLiveTraceWanted(false);
    setLiveTraceWanted(true);
    __resetForTests();
    expect(currentLiveTraceWanted()).toBe(true);
  });

  it("a foreign stored value falls back to ON instead of guessing", () => {
    store[LIVE_TRACE_KEY] = "sideways";
    __resetForTests();
    expect(currentLiveTraceWanted()).toBe(true);
  });
});

describe("the switch reaches the chat UI — the composer's three-dots menu", () => {
  const menu = stripComments(read("../components/DisclosureMenu.tsx", import.meta.url));

  it("the menu carries a checkbox row wired to the store", () => {
    expect(menu).toContain('role="menuitemcheckbox"');
    expect(menu).toContain("setLiveTraceWanted(");
    expect(menu).toContain("useLiveTraceWanted()");
  });
});

describe("the trace pane says OFF instead of showing an empty table", () => {
  const pane = stripComments(read("../components/TraceView.tsx", import.meta.url));

  it("the empty state distinguishes 'off' from 'nothing yet'", () => {
    expect(pane).toContain("liveTraceOff");
    expect(pane).toContain('"trace.liveOff"');
  });
});
