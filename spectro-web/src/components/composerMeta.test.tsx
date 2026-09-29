// Card 463 (owner, 2026-09-29): "sowohl die Auswahl des Modells als auch der
// Ring ... Die möchte ich gerne unter dem Chat haben ... ganz rechts außen soll
// der Kontext drin sein ... eine Einstellung für das Modell und eine Einstellung
// für das Thinking." The model, the thinking level and the context ring sit at
// the right end of the row under the composer, the ring last, each with its
// own menu; the header carries none of them.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerMeta, ThinkingMenu, thinkingLabel } from "./ComposerMeta";
import { blockOf, read, stripComments } from "../testkit/source";

function meta(over: Partial<Parameters<typeof ComposerMeta>[0]> = {}): string {
  return renderToStaticMarkup(
    <ComposerMeta
      provider="ollama"
      model="qwen2.5:7b"
      status="open"
      onApplyProvider={() => {}}
      liveView
      lastInputTokens={1200}
      context={null}
      onWindowOverride={() => {}}
      {...over}
    />,
  );
}

describe("the block under the composer", () => {
  it("shows the model as a button that opens its menu", () => {
    const html = meta();
    expect(html).toMatch(/class="provider-chip provider-chip--button[^"]*"[^>]*aria-haspopup="dialog"/);
    expect(html).toContain("qwen2.5:7b");
  });

  it("puts the context ring last, after the model", () => {
    const html = meta();
    expect(html.indexOf("provider-picker")).toBeGreaterThan(-1);
    expect(html.indexOf("context-wrap")).toBeGreaterThan(html.indexOf("provider-picker"));
    expect(html.trimEnd().endsWith("</span></div>")).toBe(true);
  });

  it("draws no ring before the first usage of the view", () => {
    expect(meta({ lastInputTokens: 0 })).not.toContain("context-wrap");
  });

  it("in a recorded session shows the model as a plain chip: no menu, no thinking chip", () => {
    // Review 2026-09-29: the header drew a static chip whenever it was not the
    // live view, and a switch pressed in a recorded one would go to whatever
    // socket is live.
    const html = meta({ liveView: false });
    // The ring keeps its own details popover; the chip before it offers none.
    const chip = html.slice(0, html.indexOf("context-wrap"));
    expect(chip).toContain("qwen2.5:7b");
    expect(chip).toContain("ollama");
    expect(chip).not.toContain("aria-haspopup");
    expect(chip).not.toContain("provider-chip--button");
    expect(html).not.toContain("thinking-picker");
    expect(html).toContain("context-wrap");
  });
});

describe("thinking has its own control", () => {
  it("names the pressed level, and nothing when the model offers no control", () => {
    expect(
      thinkingLabel("en", [
        { id: "off", kind: "off", pressed: false, disabled: false },
        { id: "high", kind: "effort", pressed: true, disabled: false },
      ]),
    ).toBe("high");
    expect(
      thinkingLabel("de", [
        { id: "on", kind: "on", pressed: false, disabled: false },
        { id: "off", kind: "off", pressed: true, disabled: false },
      ]),
    ).toBe("aus");
    expect(thinkingLabel("en", [])).toBeNull();
  });

  it("says default when the model's own default is in force", () => {
    expect(
      thinkingLabel("en", [
        { id: "off", kind: "off", pressed: false, disabled: false },
        { id: "high", kind: "effort", pressed: false, disabled: false },
      ]),
    ).toBe("default");
    expect(thinkingLabel("de", [{ id: "low", kind: "effort", pressed: false, disabled: false }])).toBe(
      "Standard",
    );
  });

  it("left the model's menu: the provider picker no longer carries the reasoning control", () => {
    const picker = stripComments(read("./ProviderPicker.tsx", import.meta.url));
    expect(picker).not.toContain("<ReasoningControl");
    // The menu uses the same brain as the control it replaces here.
    const own = stripComments(read("./ComposerMeta.tsx", import.meta.url));
    expect(own).toContain("segCells(");
    expect(own).toContain("cellClick(");
  });

  it("lists the levels one per row, the pressed one checked and a greyed one disabled", () => {
    const html = renderToStaticMarkup(
      <ThinkingMenu
        lang="en"
        cells={[
          { id: "off", kind: "off", pressed: false, disabled: true, reason: "cap", capAt: "low" },
          { id: "low", kind: "effort", pressed: false, disabled: false },
          { id: "high", kind: "effort", pressed: true, disabled: false },
        ]}
        showEnds
        onPick={() => {}}
      />,
    );
    const rows = [...html.matchAll(/role="menuitemradio"[^>]*>/g)].map((m) => m[0]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("disabled");
    expect(rows[2]).toContain('aria-checked="true"');
    expect(rows[1]).toContain('aria-checked="false"');
    expect(html).toContain("faster");
    expect(html).toContain("smarter");
  });
});

describe("the thinking menu and the keyboard", () => {
  it("focuses the pressed row on open, moves with the arrows and gives the focus back on Escape", () => {
    const source = stripComments(read("./ComposerMeta.tsx", import.meta.url));
    expect(source).toContain("nextMenuIndex(");
    expect(source).toMatch(/Escape[\s\S]{0,200}chip\.current\?\.focus\(\)/);
  });
});

describe("where it lives", () => {
  const chat = stripComments(read("./Chat.tsx", import.meta.url));
  const header = stripComments(read("./AppHeader.tsx", import.meta.url));

  it("is mounted in the composer row after the gear, and in the archive bar", () => {
    expect(chat.split("<ComposerMeta").length - 1).toBe(2);
    const row = chat.slice(chat.indexOf('<div className="composer-actions">'));
    expect(row.indexOf("<ComposerMeta")).toBeGreaterThan(row.indexOf("<ComposerGear"));
    const bar = chat.slice(chat.indexOf('<div className="composer archive-bar">'));
    expect(bar).toMatch(/<ComposerMeta[\s\S]*?liveView=\{false\}/);
  });

  it("owns the right end of the row; the microphone and the gear join the left group", () => {
    // Owner, 2026-09-29: "Das kann dann die rechte Seite da noch links mit
    // dran", with Claude Code's footer as the picture: microphone and settings
    // left, model, effort and ring right. When the row wraps, the block keeps
    // the right end of its line.
    const modal = read("../styles/modal-composer.css", import.meta.url);
    expect(blockOf(modal, ".composer-meta")).toMatch(/margin-left:\s*auto/);
    expect(modal).not.toMatch(/\.composer-actions \.mic-button\s*\{[^}]*margin-left:\s*auto/);
  });

  it("left the header: no provider picker, no provider chip, no ring there", () => {
    expect(header).not.toContain("<ProviderPicker");
    expect(header).not.toContain("provider-chip");
    expect(header).not.toContain("<ContextRing");
  });
});

describe("its menus open upward and hang from the row's right end", () => {
  const settings = read("../styles/settings-trace.css", import.meta.url);
  const panels = read("../styles/panels.css", import.meta.url);
  const modal = read("../styles/modal-composer.css", import.meta.url);

  it.each([
    ["the model", settings, ".provider-pop"],
    ["the thinking level", modal, ".thinking-pop"],
    ["the context ring", panels, ".context-pop"],
  ])("%s", (_, css, selector) => {
    const block = blockOf(css, selector);
    expect(block).toMatch(/bottom:\s*calc\(100% \+ \d+px\)/);
    expect(block).toMatch(/top:\s*auto/);
    expect(block).toMatch(/right:\s*0/);
    expect(block).toMatch(/max-width:\s*100%/);
  });

  it("lets the row be their frame: no anchor inside the block is positioned", () => {
    for (const anchor of [
      ".composer-meta .provider-picker",
      ".composer-meta .context-wrap",
      ".composer-meta .thinking-picker",
    ]) {
      expect(blockOf(modal, anchor), anchor).toMatch(/position:\s*static/);
    }
  });
});
