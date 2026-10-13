// Card 556 (owner, 2026-10-12): "Die Vorauswahl soll das alte Modell sein,
// aber bitte änderbar." A stored session the next message continues shows the
// model picker under its composer before the first send, preset to the pair
// its record names; an archive that cannot be continued keeps the plain chip.
//
// The Chat component is driven with the drive() probe (no DOM, house rule):
// the block under the composer is found among the elements Chat builds and
// rendered on its own.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Chat } from "./Chat";
import { ComposerMeta } from "./ComposerMeta";
import { ProviderPicker } from "./ProviderPicker";
import { initialState } from "../state/reducer";
import { drive, type El } from "../testkit/driveComponent";
import { __resetSkillList } from "../state/skillList";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSkillList();
});

const recorded = {
  provider: "llamacpp",
  model: "old-model",
  status: "open" as const,
  onApplyProvider: () => {},
};

/** The one block under the composer Chat builds for a stored session. */
function metaOf(continuable: boolean): El {
  const found = drive(
    <Chat
      state={{ ...initialState, lastInputTokens: 900 }}
      liveView={false}
      continuable={continuable}
      storedSessionId="20261012-090000-abcd"
      onSend={() => {}}
      onReturnToLive={() => {}}
      sendClient={() => true}
      composerMeta={recorded}
    />,
    [Chat],
    [],
  ).filter((el) => el.type === ComposerMeta);
  if (found.length !== 1) throw new Error(`expected one ComposerMeta, found ${found.length}`);
  return found[0];
}

/** What that block draws before the ring. */
function beforeRing(el: El): string {
  const html = renderToStaticMarkup(el);
  return html.slice(0, html.indexOf("context-wrap"));
}

describe("the block under a stored session's composer", () => {
  it("offers the picker when the next message continues the session, preset to the recorded pair", () => {
    const meta = metaOf(true);
    expect(meta.props.liveView, "still a stored session, not the live view").toBe(false);
    const html = beforeRing(meta);
    expect(html).toMatch(/class="provider-chip provider-chip--button[^"]*"[^>]*aria-haspopup="dialog"/);
    expect(html).toContain("old-model");
  });

  it("keeps the plain chip under an archive that cannot be continued", () => {
    const html = beforeRing(metaOf(false));
    expect(html).toContain("llamacpp");
    expect(html).toContain("old-model");
    expect(html).not.toContain("aria-haspopup");
    expect(html).not.toContain("provider-chip--button");
  });
});

// Fix round 1: the stored session's picker holds the recorded pair until the
// owner picks (providerPickerForm.test.ts follows the hook across the fetch);
// the live view's picker snaps a stale model as before.
describe("which picker holds the recorded pair", () => {
  const pickerOf = (meta: El): El => {
    const found = drive(meta, [ComposerMeta], []).filter((el) => el.type === ProviderPicker);
    if (found.length !== 1) throw new Error(`expected one ProviderPicker, found ${found.length}`);
    return found[0];
  };

  it("the stored session's picker holds it", () => {
    expect(pickerOf(metaOf(true)).props.holdRecorded).toBe(true);
  });

  it("the live view's picker does not", () => {
    const live = (
      <ComposerMeta {...recorded} liveView lastInputTokens={900} aiCredits={null} context={null} />
    );
    expect(pickerOf(live).props.holdRecorded).toBe(false);
  });
});
