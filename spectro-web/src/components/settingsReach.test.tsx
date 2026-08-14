// The guard the review asked for, in its own words: "the i18n guard has to grow
// a case that fails when a live sentence sits over a session-fixed field, or
// this comes back."
//
// It comes back because the sentence and the fields it is about live in two
// places that nothing connects. Card 222's first fix wrote
// "Applies immediately, including to a session already open — from its next
// tool call." under the Session-defaults grid, which holds Provider, Model,
// Address, Reasoning, Thinking, Image backend and Image model. One of the seven
// was live. The reviewer measured the rest by running it, not by reading it.
//
// So this file walks the page's SOURCE and checks the two things a reader can
// see: every field sits inside a block that names it, and no block promises a
// reach its own fields do not have. Source, not DOM, because the panel only
// draws its grids once /api/settings has answered — and because the defect is
// a static one: which sentence sits over which grid.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NOTE_REACH, ReachBlock, SETTING_REACH, noteKeyFor, reachOf } from "./settingsReach";
import type { SettingKey } from "./settingsReach";
import { dict } from "../i18n/i18n";

/**
 * The files that draw saveable settings — READ OFF THE DIRECTORY, never listed.
 *
 * Review finding F10: this used to name four files, and the settings page has
 * more. SttSettings.tsx (sttProvider, sttLanguage) and SkillsMcpSettings.tsx
 * (mcpServers) saved keys that were in no SETTING_REACH and rendered no
 * sentence at all, and the walker could not see them because nobody had added
 * them to the list. A whole settings component shipped silent, which is the
 * card's own defect wearing a build-system hat.
 */
const PAGE_FILES: string[] = readdirSync(fileURLToPath(new URL(".", import.meta.url)))
  .filter((name) => /Settings(Panel)?\.tsx$/.test(name) && !name.includes(".test."))
  .sort();

/** The file with its block comments blanked out, newlines kept so a reported
 *  line still lines up. Prose ABOUT a reach block is not a reach block — the
 *  comments in these files quote the tag by name, and a scanner that believed
 *  them would find blocks that render nothing. */
function source(file: string): string {
  const text = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** One `<ReachBlock>` as it stands in the source: what it declares, and the
 *  JSX between its tags. */
interface Block {
  file: string;
  fields: string[];
  note: string | null;
  body: string;
}

/** Every ReachBlock in one file. No nesting — a block inside a block would mean
 *  two sentences about one control, which is the ambiguity this file removes. */
function blocksIn(file: string): Block[] {
  const text = source(file);
  const out: Block[] = [];
  const open = /<ReachBlock\b([^>]*)>/g;
  for (let m = open.exec(text); m !== null; m = open.exec(text)) {
    const attrs = m[1] ?? "";
    // A block that wraps nothing writes itself self-closing: its fields are
    // drawn by a component of their own (the allowlist, the hooks), so there is
    // no JSX between tags to walk.
    const selfClosing = attrs.trimEnd().endsWith("/");
    const end = selfClosing ? m.index + m[0].length : text.indexOf("</ReachBlock>", m.index);
    expect(end, `${file}: a <ReachBlock> is never closed`).toBeGreaterThan(-1);
    const fields = [...(attrs.match(/fields=\{\[([^\]]*)\]\}/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
      (f) => f[1] as string,
    );
    out.push({
      file,
      fields,
      note: attrs.match(/note="([^"]+)"/)?.[1] ?? null,
      body: text.slice(m.index + m[0].length, end),
    });
  }
  return out;
}

/**
 * The settings a region of JSX actually renders a control for.
 *
 * Two shapes, because the page has two. An `OriginRow` carries `field="x"` and
 * names its key that way; a control without one names its key in the patch it
 * saves — `onSave({ sttProvider: … })`, `putSettings("user", { mcpServers: … })`.
 * Finding F10: only the first shape was looked for, so every control of the
 * second kind was invisible to a guard whose whole job is finding controls
 * nobody classified. The provider address field is neither: its name is chosen
 * at runtime (ollamaBaseUrl or lmstudioBaseUrl) and it stands for both.
 */
function fieldsIn(jsx: string): string[] {
  const found = [...jsx.matchAll(/field="([^"]+)"/g)].map((m) => m[1] as string);
  for (const call of jsx.matchAll(/(?:onSave\??\.?|putSettings)\(\s*(?:"[a-z]+",\s*)?\{([^}]*)\}/g)) {
    // Leading identifier per comma-separated entry — a key, not the `null` of
    // an inner `cond ? null : value`, which is what a looser match found first.
    for (const key of (call[1] ?? "").matchAll(/(?:^|,)\s*([A-Za-z][A-Za-z0-9]*)\s*:/g)) {
      found.push(key[1] as string);
    }
  }
  if (/field=\{addressSpec\.field\}/.test(jsx)) {
    found.push("ollamaBaseUrl", "lmstudioBaseUrl");
  }
  return [...new Set(found)];
}

const ALL_BLOCKS = PAGE_FILES.flatMap((file) => blocksIn(file));

describe("the sentence about when a setting lands", () => {
  it("cannot cover fields that land at different moments", () => {
    // The defect itself, as a unit. Provider is bound when the agent is built;
    // the image model is read on every call. One sentence about both is the
    // page the review found.
    expect(() => reachOf(["provider", "imageModel"])).toThrow(/do not all reach/);
    expect(reachOf(["imageModel"])).toBe("live");
    expect(reachOf(["provider", "model", "thinking"])).toBe("next-session");
  });

  it("keeps the backend's condition out of the model's unconditional sentence", () => {
    // Review finding F5. The image backend is the ONE field with a live control
    // of its own: a pick in the composer outranks a file saved under it for the
    // rest of the session. The model beside it has no such control. A single
    // "applies immediately" over both was true of one of them — which is the
    // shape of the defect this whole module exists for, one field over.
    expect(reachOf(["imageProvider"])).toBe("live-unless-picked");
    expect(() => reachOf(["imageProvider", "imageModel"])).toThrow(/do not all reach/);
  });

  it("falls back to the truthful sentence when a block brings the wrong one", () => {
    // A block may carry its own wording when the generic one leaves out a
    // reason (the allowlist's, the hooks'). It may not carry one that promises
    // more than its fields deliver: the page can be terse, not wrong.
    expect(noteKeyFor(["autoApprove"], "set.alApplies")).toBe("set.alApplies");
    expect(noteKeyFor(["autoApprove"], "set.reachLive")).toBe("set.reachNextSession");
    expect(noteKeyFor(["imageModel"], "set.hkApplies")).toBe("set.reachLive");
    // The conditional field may not borrow the unconditional sentence either —
    // that swap is exactly what the page did before finding F5.
    expect(noteKeyFor(["imageProvider"], "set.reachLive")).toBe("set.reachLiveUnlessPicked");
  });

  it("is rendered with the fields it speaks for, so the DOM can be read too", () => {
    const html = renderToStaticMarkup(
      <ReachBlock lang="en" fields={["imageModel", "chromeBinary"]}>
        <span>controls</span>
      </ReachBlock>,
    );
    expect(html).toContain('data-reach="live"');
    expect(html).toContain('data-reach-fields="imageModel chromeBinary"');
    expect(html).toContain(dict["set.reachLive"].en);
  });

  it("renders the conditional sentence with its own reach in the DOM", () => {
    // A reader — and a probe — has to be able to tell the two apart without
    // parsing prose. The attribute is the machine-readable half of the promise.
    const html = renderToStaticMarkup(
      <ReachBlock lang="en" fields={["imageProvider"]}>
        <span>controls</span>
      </ReachBlock>,
    );
    expect(html).toContain('data-reach="live-unless-picked"');
    expect(html).toContain(dict["set.reachLiveUnlessPicked"].en);
    expect(html).not.toContain(dict["set.reachLive"].en);
  });

  it("exists for every note the page may end a block with", () => {
    for (const key of Object.keys(NOTE_REACH)) {
      expect(dict[key], `${key} is promised in NOTE_REACH and missing from the dictionary`).toBeDefined();
    }
  });
});

describe("the settings page, walked", () => {
  it("says when EVERY saveable field lands", () => {
    // A field with no sentence is the silence card 222 is about: the owner had
    // a page that was right about the configuration and said nothing about the
    // run. Adding a control now means answering the question in the same edit.
    const declared = new Set(ALL_BLOCKS.flatMap((b) => b.fields));
    for (const file of PAGE_FILES) {
      for (const field of fieldsIn(source(file))) {
        expect(declared.has(field), `${file} renders "${field}" and no ReachBlock says when it lands`).toBe(
          true,
        );
      }
    }
  });

  it("never lets a block promise a reach its own fields do not have", () => {
    for (const block of ALL_BLOCKS) {
      expect(block.fields.length, `${block.file}: a ReachBlock names no fields`).toBeGreaterThan(0);
      const inside = fieldsIn(block.body);
      for (const field of inside) {
        expect(
          block.fields.includes(field),
          `${block.file}: "${field}" is drawn inside a block that speaks for ` +
            `${block.fields.join(", ")} — the sentence under it would be about other settings`,
        ).toBe(true);
      }
      // Throws when the declared fields disagree with each other; the render
      // would blow up in the same way, which is the loud half of the guard.
      const reach = reachOf(block.fields as SettingKey[]);
      if (block.note) {
        expect(
          NOTE_REACH[block.note],
          `${block.file}: the note "${block.note}" promises ${NOTE_REACH[block.note]} ` +
            `over fields that are ${reach}`,
        ).toBe(reach);
      }
    }
  });

  it("keeps the live sentence out of raw JSX", () => {
    // The concrete regression: the first fix wrote t(lang, "set.reachLive")
    // straight into the panel, above whatever happened to be there. Through the
    // block or not at all — that is what makes the two rules above binding.
    for (const file of PAGE_FILES) {
      for (const key of ["set.reachLive", "set.reachNextSession"]) {
        expect(
          source(file).includes(`"${key}"`),
          `${file} names ${key} directly — a reach sentence belongs to a ReachBlock, ` +
            `which knows which fields it is about`,
        ).toBe(false);
      }
    }
  });

  it("puts the provider pair and the image pair in different blocks", () => {
    // The review's finding, pinned as itself. Provider/model/address/thinking
    // were measured NOT to reach an open session; the image pair does — the
    // model unconditionally, the backend unless the composer's own dropdown was
    // used this session (finding F5). Three states, three blocks.
    const holder = (field: string) => ALL_BLOCKS.find((b) => b.fields.includes(field));
    const provider = holder("provider");
    const image = holder("imageProvider");
    const model = holder("imageModel");
    expect(provider, "no block speaks for the provider").toBeDefined();
    expect(image, "no block speaks for the image backend").toBeDefined();
    expect(model, "no block speaks for the image model").toBeDefined();
    expect(reachOf(provider!.fields as SettingKey[])).toBe("next-session");
    expect(reachOf(image!.fields as SettingKey[])).toBe("live-unless-picked");
    expect(reachOf(model!.fields as SettingKey[])).toBe("live");
    expect(provider).not.toBe(image);
    expect(image).not.toBe(model);
    for (const field of ["model", "thinking", "ollamaBaseUrl", "lmstudioBaseUrl"]) {
      expect(
        provider!.fields.includes(field),
        `"${field}" was measured to stay behind in an open session and belongs beside the provider`,
      ).toBe(true);
    }
  });

  it("classifies every field the page can save", () => {
    for (const file of PAGE_FILES) {
      for (const field of fieldsIn(source(file))) {
        expect(
          Object.prototype.hasOwnProperty.call(SETTING_REACH, field),
          `${file} saves "${field}" and SETTING_REACH does not say when it lands`,
        ).toBe(true);
      }
    }
  });
});
