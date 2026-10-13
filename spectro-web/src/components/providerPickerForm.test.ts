// Card 556, fix round 1: in a stored session the picker's preselection stays
// the pair the record names until the owner picks.
//
// The picker's model list comes from GET /api/models. A local backend's list
// is authoritative, so the live picker snaps a model the list does not carry
// to the first real one (autoPick, providerModelField.tsx). Under a stored
// session that snap would move the preselection off the recorded model the
// moment the picker opens, whenever that model is gone from a reachable
// backend's list. The form now holds the recorded pair there; once the owner
// picks another provider the snap works as before.
//
// The hook runs in testkit/hookHost.ts (React's hooks swapped for a host that
// follows state across the fetch), so the snap is observed, not assumed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HookHost } from "../testkit/hookHost";
import { usePickerForm, type PickerForm } from "./providerPickerForm";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { fakeHooks } = await import("../testkit/hookHost");
  return { ...actual, ...fakeHooks };
});

const LIST = ["qwen3", "llama3"];
const STATUS = { ollama: "local", lmstudio: "local" };

let asked: string[] = [];

beforeEach(() => {
  asked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      asked.push(url);
      return { ok: true, json: async () => LIST };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Lets the fetch and its continuations run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function open(holdRecorded: boolean): HookHost<PickerForm> {
  return new HookHost(() =>
    usePickerForm({
      open: true,
      provider: "ollama",
      activeModel: "old-model",
      providerStatus: STATUS,
      holdRecorded,
    }),
  );
}

describe("the picker's preselection", () => {
  it("in a stored session stays the recorded pair when the backend's list lacks the model", async () => {
    const host = open(true);
    await settle();
    expect(asked, "positive: the list was fetched").toEqual(["/api/models?provider=ollama"]);
    expect(host.value.models).toEqual(LIST);
    expect(host.value.sel).toBe("ollama");
    expect(host.value.model).toBe("old-model");
    host.unmount();
  });

  it("in the live view snaps a model the list lacks to the first real one, as before", async () => {
    const host = open(false);
    await settle();
    expect(host.value.models).toEqual(LIST);
    expect(host.value.model).toBe("qwen3");
    host.unmount();
  });

  it("in a stored session follows the list once the owner picks another provider", async () => {
    const host = open(true);
    await settle();
    host.value.chooseProvider("lmstudio");
    await settle();
    expect(host.value.sel).toBe("lmstudio");
    expect(host.value.model).toBe("qwen3");
    host.unmount();
  });

  it("keeps a model the owner chose by hand", async () => {
    const host = open(true);
    await settle();
    host.value.setModel("llama3");
    await settle();
    expect(host.value.model).toBe("llama3");
    host.unmount();
  });
});
