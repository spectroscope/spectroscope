// Card 512, fix round: a field's chooser note does not outlive the field. The
// notes live in a module store, so without a clear on unmount a 409 or 501 note
// stayed after the pane or the wizard step went away and showed again on the
// next visit. The field clears its own slot when it mounts and when it
// unmounts, and leaves the other slots alone.
//
// The server renderer runs no effects, so this file records the effects that
// usePickNote registers and runs them by hand, mount first, then the cleanup
// it returns.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "../i18n/i18n";
import { __resetFolderPick, chooseFolder, usePickNote, type PickSlot } from "./folderPick";
import { setLang } from "./lang";

type Effect = () => void | (() => void);

const effects = vi.hoisted(() => [] as Effect[]);

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: Effect) => {
      effects.push(effect);
    },
  };
});

function Note({ slot }: { slot: PickSlot }) {
  return <p>{usePickNote(slot) ?? ""}</p>;
}

const note = (slot: PickSlot): string => renderToStaticMarkup(<Note slot={slot} />);

/** Renders the field once and runs its mount effects; returns their cleanups. */
function mount(slot: PickSlot): () => void {
  effects.length = 0;
  note(slot);
  expect(effects.length).toBeGreaterThan(0);
  const cleanups = effects.map((e) => e());
  return () => {
    for (const c of cleanups) if (typeof c === "function") c();
  };
}

let status = 409;

beforeEach(() => {
  effects.length = 0;
  __resetFolderPick();
  setLang("en");
  status = 409;
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) } as unknown as Response),
    ),
  );
});

afterEach(() => {
  effects.length = 0;
  __resetFolderPick();
  vi.unstubAllGlobals();
});

describe("a chooser note and its field", () => {
  it("is gone once the field unmounts", async () => {
    const unmount = mount("pane");
    await chooseFolder("pane", () => {});
    expect(note("pane")).toContain(dict["pick.busy"].en);
    unmount();
    expect(note("pane")).not.toContain(dict["pick.busy"].en);
  });

  it("is gone when the field mounts again after a pick that ended while it was away", async () => {
    status = 501;
    await chooseFolder("lyzrPlaybook", () => {});
    expect(note("lyzrPlaybook")).toContain(dict["pick.paste"].en);
    mount("lyzrPlaybook");
    expect(note("lyzrPlaybook")).not.toContain(dict["pick.paste"].en);
  });

  it("leaves the notes of the other fields alone", async () => {
    await chooseFolder("lyzrDir", () => {});
    const unmount = mount("pane");
    unmount();
    expect(note("lyzrDir")).toContain(dict["pick.busy"].en);
  });
});
