// Card 554, task 13, criterion 4: the composer takes what the header's play
// button asked for. useTakePrefill is the composer's half of the store: an
// open composer takes a waiting request once, hands its text on and clears
// it; a closed one leaves it waiting for the next composer that opens.
// prefilledDraft decides what the draft becomes: words the owner already
// typed stay, after the command, as its prompt.

import { afterEach, describe, expect, it, vi } from "vitest";
import { HookHost } from "../testkit/hookHost";
import {
  __resetComposerPrefill,
  currentPrefill,
  prefilledDraft,
  prefillComposer,
  useTakePrefill,
} from "./composerPrefill";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

afterEach(() => {
  __resetComposerPrefill();
});

describe("the composer taking a prefill", () => {
  it("takes a waiting request once it is open, hands the text on and clears the request", () => {
    const taken: string[] = [];
    prefillComposer("/run-with-playbook ");
    const host = new HookHost(() => useTakePrefill(true, (text) => void taken.push(text)));
    expect(taken).toEqual(["/run-with-playbook "]);
    expect(currentPrefill()).toBeNull();
    host.invalidate();
    expect(taken, "a request is taken once").toEqual(["/run-with-playbook "]);
    host.unmount();
  });

  it("leaves the request waiting while the composer is closed, and takes it when it opens", () => {
    const taken: string[] = [];
    let open = false;
    prefillComposer("/run-with-playbook ");
    const host = new HookHost(() => useTakePrefill(open, (text) => void taken.push(text)));
    expect(taken).toEqual([]);
    expect(currentPrefill()?.text).toBe("/run-with-playbook ");
    open = true;
    host.invalidate();
    expect(taken).toEqual(["/run-with-playbook "]);
    host.unmount();
  });

  it("takes the same text asked for a second time", () => {
    const taken: string[] = [];
    const host = new HookHost(() => useTakePrefill(true, (text) => void taken.push(text)));
    prefillComposer("/run-with-playbook ");
    host.invalidate();
    prefillComposer("/run-with-playbook ");
    host.invalidate();
    expect(taken).toEqual(["/run-with-playbook ", "/run-with-playbook "]);
    host.unmount();
  });
});

describe("the draft a prefill leaves", () => {
  it("is the command for an empty draft", () => {
    expect(prefilledDraft("/run-with-playbook ", "")).toBe("/run-with-playbook ");
    expect(prefilledDraft("/run-with-playbook ", "   ")).toBe("/run-with-playbook ");
  });

  it("keeps words the owner already typed as the prompt after the command", () => {
    expect(prefilledDraft("/run-with-playbook ", "add a CSV export")).toBe(
      "/run-with-playbook add a CSV export",
    );
    expect(prefilledDraft("/run-with-playbook ", "  add a CSV export")).toBe(
      "/run-with-playbook add a CSV export",
    );
  });

  it("leaves a draft that already is the command as it is", () => {
    expect(prefilledDraft("/run-with-playbook ", "/run-with-playbook add it")).toBe(
      "/run-with-playbook add it",
    );
  });

  it("loses nothing: a draft that opens with a slash stays after the command too", () => {
    expect(prefilledDraft("/run-with-playbook ", "/clean-code tidy this")).toBe(
      "/run-with-playbook /clean-code tidy this",
    );
  });
});
