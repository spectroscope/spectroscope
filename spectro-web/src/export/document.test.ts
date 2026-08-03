// The composed document: one file that can carry several views of the same run,
// and both languages of a translated one, with no script in it.
//
// NO SCRIPT is the invariant everything else here bends to. The tabs are radio
// inputs and sibling selectors, not a click handler, because the file has to
// work from file:// with the network unplugged and because a preview that needs
// scripts enabled to look right is a preview that proves nothing about the file.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { composeDocument } from "./document";
import { DEFAULT_REQUEST } from "./options";

const ts = 1_783_500_000_000;

const events: RunEvent[] = [
  { type: "run_start", runId: "r", agentId: "main", prompt: "hello", ts },
  { type: "text_delta", agentId: "main", text: "world", ts: ts + 1 },
  { type: "tool_call", agentId: "main", callId: "c1", name: "read_file", input: { path: "a" }, ts: ts + 2 },
  {
    type: "tool_result",
    agentId: "main",
    callId: "c1",
    output: "body",
    isError: false,
    durationMs: 1,
    ts: ts + 3,
  },
  { type: "run_end", runId: "r", stopReason: "end_turn", ts: ts + 4 },
] as RunEvent[];

const base = { ...DEFAULT_REQUEST, now: ts, label: "demo" };

describe("one view", () => {
  it("writes a whole html document", () => {
    const html = composeDocument({ ...base, views: ["chat"], primary: "chat" }, { original: events });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("shows no tab strip when there is only one view", () => {
    const html = composeDocument({ ...base, views: ["chat"], primary: "chat" }, { original: events });
    expect(html).not.toContain('name="x-view"');
  });
});

describe("several views in one file", () => {
  const html = composeDocument(
    { ...base, views: ["chat", "text", "json"], primary: "text" },
    { original: events },
  );

  it("carries every chosen view's content", () => {
    expect(html).toContain("world"); // the chat answer
    expect(html).toContain("[tool_call"); // the text feed's protocol marker
    // The json view is the text tab's own: one compact line per event.
    expect(html).toContain("&quot;type&quot;:&quot;run_start&quot;");
  });

  it("selects the view the export was taken from", () => {
    const checked = /<input[^>]*id="x-tab-text"[^>]*>/.exec(html);
    expect(checked?.[0]).toContain("checked");
  });

  it("switches with CSS alone", () => {
    expect(html).toContain('name="x-view"');
    expect(html).toContain(":checked");
  });
});

describe("the json view is labelled as the view, not as the download", () => {
  it("says which frames the text tab omits, in both groups", () => {
    // Both writers filter through nonWire.ts, so the view and the download hold
    // the same lines; what neither holds is a socket frame or a frame an import
    // read around the conversation. This assertion used to read "socket-only",
    // and it kept the label green after the filter widened past it.
    const html = composeDocument({ ...base, views: ["json"], primary: "json" }, { original: events });
    expect(html.toLowerCase()).toContain("socket frames");
    expect(html.toLowerCase()).toContain("imported frames");
  });
});

describe("the language switcher", () => {
  const translated: RunEvent[] = events.map((e) =>
    e.type === "text_delta" ? { ...e, text: "Welt" } : e,
  ) as RunEvent[];

  const html = composeDocument(
    { ...base, views: ["chat"], primary: "chat", switcher: true },
    { original: events, translated, translatedTo: "de" },
  );

  it("puts both languages in the one file", () => {
    expect(html).toContain("world");
    expect(html).toContain("Welt");
  });

  it("switches with CSS alone", () => {
    expect(html).toContain('name="x-lang"');
  });

  it("is absent when no translation was handed over", () => {
    const plain = composeDocument(
      { ...base, views: ["chat"], primary: "chat", switcher: true },
      { original: events },
    );
    expect(plain).not.toContain('name="x-lang"');
  });

  it("is absent when only one side is in hand, but still says so", () => {
    // The text tab is handed the already-translated stream and cannot recover
    // the original. It gets the provenance line and no switcher, rather than a
    // control that flips between two identical documents.
    const oneSided = composeDocument(
      { ...base, views: ["text"], primary: "text", switcher: true },
      { original: translated, translated, translatedTo: "de" },
    );
    expect(oneSided).not.toContain('name="x-lang"');
    expect(oneSided).toContain("translated to de");
  });

  it("says the file is a translation and into what", () => {
    expect(html).toContain("de");
  });
});

describe("self-containment", () => {
  const html = composeDocument(
    { ...base, views: ["chat", "text", "json"], primary: "chat", switcher: true },
    { original: events, translated: events, translatedTo: "de" },
  );

  it("carries no script", () => {
    expect(/<script/i.test(html)).toBe(false);
    // Inline handlers are script by another name.
    expect(/\son[a-z]+\s*=/i.test(html)).toBe(false);
  });

  it("fetches nothing when it opens", () => {
    expect(/<link\b/i.test(html)).toBe(false);
    expect(/@import/i.test(html)).toBe(false);
    // url() would reach the network for a font or a background.
    expect(/url\(/i.test(html)).toBe(false);
    // Every src must be bytes already in the file.
    for (const m of html.matchAll(/\bsrc="([^"]*)"/g)) expect(m[1].startsWith("data:")).toBe(true);
    // An http(s) reference may only appear as a link a reader chooses to follow.
    for (const m of html.matchAll(/https?:\/\/[^\s"']+/g)) {
      expect(html.slice(Math.max(0, m.index - 60), m.index)).toMatch(/<a\s|href="$/);
    }
  });
});

describe("disclosure defaults", () => {
  it("opens tool cards when asked to", () => {
    const html = composeDocument(
      { ...base, views: ["chat"], primary: "chat", tools: "open" },
      { original: events },
    );
    expect(html).toContain('<details class="x-tool" open');
  });

  it("leaves them folded when asked to", () => {
    const html = composeDocument(
      { ...base, views: ["chat"], primary: "chat", tools: "collapsed" },
      { original: events },
    );
    expect(html).not.toContain('<details class="x-tool" open');
    expect(html).toContain('<details class="x-tool"');
  });
});

describe("the theme is the one that was picked", () => {
  it("prints the paper ground when paper was chosen", () => {
    const html = composeDocument(
      { ...base, views: ["chat"], primary: "chat", theme: "paper" },
      { original: events },
    );
    expect(html).toContain("--bg: #f6f4ee");
    expect(html).toContain("color-scheme: light");
  });

  it("names the theme in the header instead of always saying dark", () => {
    const html = composeDocument(
      { ...base, views: ["chat"], primary: "chat", theme: "paper" },
      { original: events },
    );
    expect(html).toContain("paper");
    expect(html).not.toMatch(/·\s*dark\s*</);
  });
});

describe("print", () => {
  it("gives the print sheet a real light ground, not just a white body", () => {
    const html = composeDocument({ ...base, views: ["chat"], primary: "chat" }, { original: events });
    const print = /@media print\{([\s\S]*?)\n\}/.exec(html);
    expect(print).not.toBeNull();
    // Token-coloured surfaces stay dark if only body is whitened.
    expect(print?.[1]).toContain("--surface");
  });

  it("reaches for the disclosure through the selector that actually fires", () => {
    // Measured in Chrome 150: the child rule alone moves nothing, because a
    // closed card hides its contents through ::details-content. Both rules
    // ship; neither is the guarantee (the dialog presets expansion for print).
    const html = composeDocument(
      { ...base, views: ["chat"], primary: "chat", tools: "collapsed" },
      { original: events },
    );
    const print = /@media print\{([\s\S]*?)\n\}/.exec(html);
    expect(print?.[1]).toContain("::details-content");
    expect(print?.[1]).toContain("content-visibility:visible");
  });
});
