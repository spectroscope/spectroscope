// Card 605, task 12 item 5: a folder of Copilot session folders opens a list in
// the import dialog instead of loading. The suite has no DOM: the list renders
// on the server renderer and the drive kit presses its rows.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CopilotStoreRow } from "../import/copilotFolder";
import { read } from "../testkit/source";
import { drive, type El } from "../testkit/driveComponent";
import { CopilotStoreList } from "./ImportDialog";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const rows: CopilotStoreRow[] = [
  {
    session: 1,
    id: "1234abcd",
    name: null,
    created: Date.parse("2026-11-10T09:00:00.000Z"),
    client: null,
    bytes: 900,
    live: true,
  },
  {
    session: 0,
    id: "9876fedc",
    name: "Parser test",
    created: Date.parse("2026-11-07T12:00:00.000Z"),
    client: "copilot-intellij",
    bytes: 3 * 1024 * 1024,
    live: false,
  },
];

const render = (lang: "en" | "de", skipped = 0, picked: number[] = []) =>
  renderToStaticMarkup(
    <CopilotStoreList
      lang={lang}
      rows={rows}
      skipped={skipped}
      now={NOW}
      busy={false}
      onPick={(i) => picked.push(i)}
    />,
  );

describe("the list of a Copilot store (item 5)", () => {
  it("says how many sessions the folder holds, and how many it left out", () => {
    expect(render("en")).toContain("2 Copilot sessions in this folder.");
    expect(render("en")).not.toContain("not listed");
    expect(render("en", 2)).toContain(
      "2 Copilot sessions in this folder. 2 folders without an events.jsonl are not listed.",
    );
    expect(render("en", 1)).toContain("1 folder without an events.jsonl is not listed.");
    expect(render("de", 2)).toContain(
      "2 Copilot-Sessions in diesem Ordner. 2 Ordner ohne events.jsonl sind nicht aufgeführt.",
    );
    expect(render("de", 1)).toContain("1 Ordner ohne events.jsonl ist nicht aufgeführt.");
  });

  it("gives each row its name, time, client, size and live mark, newest first as given", () => {
    const en = render("en");
    expect(en.indexOf("unnamed session")).toBeLessThan(en.indexOf("Parser test"));
    expect(en).toContain("in use");
    expect(en).toContain("copilot-intellij");
    expect(en).toContain("3.0 MB");
    expect(en).toContain("1 kB");
    expect(en).toContain("3 h ago");
    expect(en).toContain("3 d ago");
    const de = render("de");
    expect(de).toContain("Session ohne Namen 1234abcd");
    expect(en).toContain("unnamed session 1234abcd");
    // A named row keeps its name alone.
    expect(en).not.toContain("9876fedc");
    expect(de).toContain("belegt");
    expect(de).toContain("vor 3 h");
    // Only the first row is live.
    expect(en.match(/>in use</g)).toHaveLength(1);
  });

  it("makes every row a button the keyboard reaches", () => {
    const html = render("en");
    expect(html.match(/<button type="button"/g)).toHaveLength(2);
    expect(html).not.toContain('tabindex="-1"');
  });

  it("a row's press chooses that session", () => {
    const picked: number[] = [];
    drive(
      <CopilotStoreList
        lang="en"
        rows={rows}
        skipped={0}
        now={NOW}
        busy={false}
        onPick={(i) => picked.push(i)}
      />,
      [CopilotStoreList],
      [
        (tree: El[]) => {
          const buttons = tree.filter((el) => el.type === "button");
          buttons[1].props.onClick?.();
          buttons[0].props.onClick?.();
        },
      ],
    );
    expect(picked).toEqual([0, 1]);
  });

  it("a load in flight holds every row", () => {
    const html = renderToStaticMarkup(
      <CopilotStoreList lang="en" rows={rows} skipped={0} now={NOW} busy={true} onPick={() => {}} />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});

describe("the dialog opens the list for a store and loads the row chosen", () => {
  // Read as written: the hint's "~/.claude/projects/…/*.jsonl" opens what a comment stripper takes for a comment.
  const dialog = read("./ImportDialog.tsx", import.meta.url);

  it("builds the rows from the store group and reads only that folder on a press", () => {
    expect(dialog).toMatch(
      /group\.kind === "copilot-store"\) \{[\s\S]*?copilotStoreRows\(list, group\.sessions\)/,
    );
    expect(dialog).toMatch(
      /<CopilotStoreList[\s\S]*?onPick=\{\(i\) => loadCopilotPick\(copilotStore\.files, copilotStore\.sessions\[i\]\)\}/,
    );
    expect(dialog).not.toMatch(/group\.kind === "copilot-store"\) \{\s*setError/);
  });
});
