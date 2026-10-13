// Card 554, criteria 4 and 8e: in developer mode the header has a playbook
// dropdown and a play button beside the folder chip.
//
// The dropdown shows the playbook the session picked; with no pick it shows
// the folder's pinned playbook as a suggestion, which is not stored (owner
// answer 5). Only a pick the owner makes leaves, through the host's onPick
// (set_playbook, wired by task 13). A picked folder that is gone says so. The
// play button writes "/run-with-playbook " into the composer and starts
// nothing. Static markup and the drive() probe, no DOM (house rule).

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaybookChip, PlaybookChipView } from "./PlaybookChip";
import { __resetComposerPrefill, currentPrefill } from "../state/composerPrefill";
import { setLang } from "../state/lang";
import { drive, type El } from "../testkit/driveComponent";
import type { PlaybookPick } from "../state/playbookChat";

const FOLDERS = ["/pb/spectro", "/pb/team-x"];

let picks: (string | null)[] = [];
let plays = 0;

afterEach(() => {
  picks = [];
  plays = 0;
  setLang("en");
  __resetComposerPrefill();
});

function view(pick: PlaybookPick | null, pinned: string | null = "/pb/spectro", folders = FOLDERS) {
  return (
    <PlaybookChipView
      folders={folders}
      pinned={pinned}
      pick={pick}
      onPick={(dir) => void picks.push(dir)}
      onPlay={() => void plays++}
    />
  );
}

const html = (el: ReturnType<typeof view>): string => renderToStaticMarkup(el);

describe("the playbook dropdown", () => {
  it("shows the folder's pinned playbook as a suggestion, and stores nothing by showing it", () => {
    const out = html(view(null));
    expect(out).toContain('data-state="suggested"');
    expect(out).toMatch(/<option value="\/pb\/spectro" selected="">spectro<\/option>/);
    expect(out).toContain("suggested for this folder");
    expect(picks).toEqual([]);
  });

  it("shows the session's pick by its name, as a pick and not a suggestion", () => {
    const out = html(view({ dir: "/pb/team-x", name: "Team X", found: true }));
    expect(out).toContain('data-state="picked"');
    expect(out).toMatch(/<option value="\/pb\/team-x" selected="">Team X<\/option>/);
    expect(out).not.toContain("suggested for this folder");
  });

  it("lists every registered folder by its folder name", () => {
    const out = html(view(null));
    expect(out).toContain('<option value="/pb/team-x">team-x</option>');
  });

  it("asks for a pick when nothing is picked and nothing is pinned, and the play button waits", () => {
    const out = html(view({ dir: null, name: null, found: false }, null));
    expect(out).toContain('data-state="none"');
    expect(out).toMatch(/<option value="" disabled="" selected="">Pick a playbook<\/option>/);
    expect(out).toMatch(/<button[^>]*class="pb-chip-play"[^>]*disabled=""/);
  });

  it("says when the picked folder is gone, keeps it shown and refuses the play", () => {
    const out = html(view({ dir: "/pb/gone", name: null, found: false }));
    expect(out).toContain('data-state="gone"');
    expect(out).toMatch(/<option value="\/pb\/gone" selected="">gone<\/option>/);
    expect(out).toContain("not found");
    expect(out).toMatch(/<button[^>]*class="pb-chip-play"[^>]*disabled=""/);
  });

  it("sends a pick the owner makes, and only that", () => {
    const choose = (tree: El[]): void => {
      const select = tree.find((el) => el.type === "select");
      expect(select, "the dropdown is drawn").toBeDefined();
      (select?.props.onChange as (e: { target: { value: string } }) => void)({
        target: { value: "/pb/team-x" },
      });
    };
    drive(view(null), [PlaybookChipView], [choose]);
    expect(picks).toEqual(["/pb/team-x"]);
  });

  // Integrator decision b: "No playbook" is an option of its own.
  it("offers No playbook, and choosing it sends the explicit none", () => {
    expect(html(view(null))).toContain('<option value="__none__">No playbook</option>');
    const choose = (tree: El[]): void => {
      const select = tree.find((el) => el.type === "select");
      (select?.props.onChange as (e: { target: { value: string } }) => void)({
        target: { value: "__none__" },
      });
    };
    drive(view(null), [PlaybookChipView], [choose]);
    expect(picks).toEqual([null]);
  });

  it("shows an explicit none as picked, without the folder's suggestion, and the play button waits", () => {
    const out = html(view({ dir: null, name: null, found: false, none: true }));
    expect(out).toContain('data-state="off"');
    expect(out).toMatch(/<option value="__none__" selected="">No playbook<\/option>/);
    expect(out).not.toContain("suggested for this folder");
    expect(out).toMatch(/<button[^>]*class="pb-chip-play"[^>]*disabled=""/);
  });

  it("is no icon button of the header's table", () => {
    const out = html(view(null));
    expect(out).not.toContain("icon-button");
    expect(out).not.toContain("data-header-icon");
  });

  it("speaks German", () => {
    setLang("de");
    const out = html(view(null));
    expect(out).toContain("Vorschlag für diesen Ordner");
    expect(html(view({ dir: "/pb/gone", name: null, found: false }))).toContain("nicht gefunden");
    expect(out).toContain('<option value="__none__">Kein Playbook</option>');
  });
});

describe("the play button", () => {
  const press = (tree: El[]): void => {
    const button = tree.find((el) => el.type === "button" && el.props.className === "pb-chip-play");
    expect(button, "the play button is drawn").toBeDefined();
    button?.props.onClick?.();
  };

  it("hands the host's play to the view", () => {
    drive(view(null), [PlaybookChipView], [press]);
    expect(plays).toBe(1);
    expect(picks, "playing is not picking").toEqual([]);
  });

  it("writes /run-with-playbook into the composer, brings the composer forward and starts nothing", () => {
    let shown = 0;
    drive(
      <PlaybookChip
        workspace="/ws"
        pick={{ dir: "/pb/spectro", name: "spectro", found: true }}
        onPick={(d) => void picks.push(d)}
        onShowComposer={() => void shown++}
      />,
      [PlaybookChip, PlaybookChipView],
      [press],
    );
    expect(currentPrefill()?.text).toBe("/run-with-playbook ");
    expect(shown, "task 13: the composer comes on screen").toBe(1);
    expect(picks).toEqual([]);
  });
});
