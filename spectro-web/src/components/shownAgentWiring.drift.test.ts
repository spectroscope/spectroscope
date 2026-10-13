// Card 593: one selection drives every agent view. App resolves it once and
// hands the same ShownAgent and one pick to the chat's composer row and to
// the right panel; the composer row hands it to the ring. Read off disk (no
// DOM in this suite).
import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));
const chat = stripComments(read("./Chat.tsx", import.meta.url));
const meta = stripComments(read("./ComposerMeta.tsx", import.meta.url));

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("App resolves the shown agent once per render", () => {
  it("reads the store by the view key and resolves against the view", () => {
    expect(count(app, "shownAgentOf(view, chosenAgent)")).toBe(1);
    expect(app).toContain("useShownAgent(viewKey)");
    expect(app).toMatch(
      /const onPickAgent = useCallback\(\(id: string \| null\) => setShownAgent\(viewKey, id\), \[viewKey\]\);/,
    );
  });

  it("hands it to the chat through composerMeta", () => {
    const block = app.slice(app.indexOf("composerMeta: {"), app.indexOf("onWindowOverride:"));
    expect(block).toContain("shown: shownAgent,");
    expect(block).toContain("onPickAgent,");
  });

  it("forgets the choice of a record that closed", () => {
    expect(app).toContain(
      "for (const key of closedViewKeys(knownViewKeys.current, now)) forgetShownAgent(key);",
    );
  });
});

describe("the chat and the composer row hand it to the ring", () => {
  it("at both ComposerMeta sites of the chat", () => {
    expect(count(chat, "ring={ringOf(props.composerMeta, state)}")).toBe(2);
  });

  it("and the row gives the ring its picker and the shown agent's figures", () => {
    const ring = meta.slice(meta.indexOf("<ContextRing"), meta.indexOf("/>", meta.indexOf("<ContextRing")));
    expect(ring).toContain("picker={props.ring?.picker}");
    expect(ring).toContain("lastInputTokens={figures.lastInputTokens}");
    expect(ring).toContain("context={figures.context}");
    expect(ring).toContain("announcedWindow={figures.announcedWindow}");
  });
});

describe("the right panel follows the same selection", () => {
  const panel = stripComments(read("./RightPanel.tsx", import.meta.url));

  it("keeps no selection of its own any more", () => {
    expect(panel).not.toContain("selectedId, setSelectedId");
    expect(panel).toContain("const selected = shown.row;");
  });

  it("a click on an agent row picks it and opens the context panel, as before", () => {
    const site = panel.slice(
      panel.indexOf("const selectAgent = "),
      panel.indexOf("};", panel.indexOf("const selectAgent = ")),
    );
    expect(site).toContain("onPickAgent(id);");
    expect(site).toContain('openDockPanel("context");');
    expect(panel).toContain("selectedId={shown.id}");
  });

  it("App hands it the resolved agent, the pick and the plans per writer", () => {
    // The element holds a nested <AnalyzeRun /> in its analyze prop, so the
    // slice ends at the workspace prop, which follows the three of this card.
    const mount = app.slice(
      app.indexOf("<RightPanel"),
      app.indexOf("workspace={", app.indexOf("<RightPanel")),
    );
    expect(mount).toContain("shown={shownAgent}");
    expect(mount).toContain("onPickAgent={onPickAgent}");
    expect(mount).toContain("plans={view.plans}");
    expect(mount).not.toContain("plan={view.plan}");
  });
});
