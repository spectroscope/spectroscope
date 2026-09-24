// Card 410: the catalogue shelf reads as packs. Owner, 2026-09-24: "dass wir
// die einklappen und man kann die ausklappen und einzeln installieren, aber
// dass wir einfach diese Skillsets mit einem Button installieren".
//
// There is no DOM in this suite, so nothing is clicked. `renderToStaticMarkup`
// gives what a pack shows, and the element tree gives the wiring: a pack's
// buttons are found as elements and their handlers called, and the fetch
// stub sees what the press sent. CataloguePack is hook-free for exactly that.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CataloguePack, CatalogueShelf } from "./SkillsMcpSettings";
import { packGroups, type PackGroup } from "../state/skillPacks";
import {
  installSet,
  resetInstallState,
  resetPackState,
  resetRowRemoval,
  rowRemoval,
  type CatalogueRow,
  type PackRefusal,
} from "../state/skillInstall";
import { dict, type Lang } from "../i18n/i18n";

const row = (pack: string, name: string, root: "user" | "project" | null = null): CatalogueRow => ({
  id: `${pack}/${name}`,
  name,
  pack,
  description: `${name} does one thing.`,
  licence: "MIT",
  repo: "https://example.com/repo",
  commit: "0".repeat(40),
  files: 3,
  bytes: 1200,
  installed: root !== null,
  root,
});

/** The card's fixture: pack alpha, four skills, two installed; pack beta, two, none. */
const FIXTURE: CatalogueRow[] = [
  row("alpha", "a1", "user"),
  row("alpha", "a2", "user"),
  row("alpha", "a3"),
  row("alpha", "a4"),
  row("beta", "b1"),
  row("beta", "b2"),
];

type Btn = ReactElement<{
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  role?: string;
  "aria-checked"?: boolean;
  "aria-expanded"?: boolean;
  children?: ReactNode;
}>;

/** Every button in an element tree, in document order. A component element is
 *  called in place, which only works for hook-free components. */
function buttons(node: ReactNode): Btn[] {
  const found: Btn[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as ReactElement<{ children?: ReactNode }>;
    if (typeof el.type === "function") {
      walk((el.type as (p: unknown) => ReactNode)(el.props));
      return;
    }
    if (el.type === "button") found.push(el as Btn);
    walk(el.props.children);
  };
  walk(node);
  return found;
}

const byClass = (all: Btn[], cls: string): Btn[] =>
  all.filter((b) => (b.props.className ?? "").split(/\s+/).includes(cls));

/** The text a button shows, for the label assertions. */
const label = (b: Btn): string => renderToStaticMarkup(b).replace(/<[^>]+>/g, "");

const count = (html: string, cls: string): number =>
  [...html.matchAll(/class="([^"]*)"/g)].filter((m) => (m[1] ?? "").split(/\s+/).includes(cls)).length;

function pack(
  group: PackGroup,
  over: Partial<{
    open: boolean;
    busy: boolean;
    pendingSet: "install" | "remove" | null;
    refused: PackRefusal | null;
    lang: Lang;
    reload: () => void;
    onToggle: () => void;
    removingId: string | null;
  }> = {},
): ReactElement {
  return (
    <CataloguePack
      group={group}
      lang={over.lang ?? "en"}
      open={over.open ?? false}
      onToggle={over.onToggle ?? (() => {})}
      busy={over.busy ?? false}
      pendingSet={over.pendingSet ?? null}
      installingId={null}
      removingId={over.removingId ?? null}
      refused={over.refused ?? null}
      reload={over.reload ?? (() => {})}
    />
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetInstallState();
  resetPackState();
  resetRowRemoval();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const sent = (call: number): { url: string; method: string | undefined; body: unknown } => {
  const [url, init] = fetchMock.mock.calls[call] as [string, RequestInit | undefined];
  return {
    url,
    method: init?.method,
    body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
  };
};

describe("criterion 1: one header per pack, with installed of total", () => {
  it("renders two pack headers reading 2 of 4 and 0 of 2", () => {
    const html = renderToStaticMarkup(<CatalogueShelf catalogue={FIXTURE} lang="en" reload={() => {}} />);

    expect(count(html, "skset-pack-head")).toBe(2);
    expect(html).toContain("2 of 4 installed");
    expect(html).toContain("0 of 2 installed");
    expect(html.indexOf(">alpha<")).toBeLessThan(html.indexOf(">beta<"));
  });

  it("says the count in German too", () => {
    const html = renderToStaticMarkup(<CatalogueShelf catalogue={FIXTURE} lang="de" reload={() => {}} />);
    expect(html).toContain("2 von 4 installiert");
  });
});

describe("criterion 2: collapsed by default", () => {
  it("mounted fresh, shows only the headers and their two set buttons, no skill row", () => {
    const html = renderToStaticMarkup(<CatalogueShelf catalogue={FIXTURE} lang="en" reload={() => {}} />);

    expect(count(html, "skset-row")).toBe(0);
    expect(html).not.toContain("a1 does one thing.");
    expect(count(html, "skset-pack-install")).toBe(2);
    expect(count(html, "skset-pack-remove")).toBe(2);
    expect([...html.matchAll(/aria-expanded="false"/g)]).toHaveLength(2);
    expect(html).not.toContain('aria-expanded="true"');
  });

  it("the toggle is the header's own button and asks to open", () => {
    const onToggle = vi.fn();
    const [alpha] = packGroups(FIXTURE);
    const toggle = byClass(buttons(pack(alpha, { onToggle })), "skset-pack-toggle");

    expect(toggle).toHaveLength(1);
    expect(toggle[0].props["aria-expanded"]).toBe(false);
    toggle[0].props.onClick?.();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("criterion 3: one button per set, both directions", () => {
  it("pack alpha's install button says 2 and installs exactly the two missing skills", () => {
    const reload = vi.fn();
    const [alpha] = packGroups(FIXTURE);
    const [install] = byClass(buttons(pack(alpha, { reload })), "skset-pack-install");

    expect(label(install)).toBe("install 2");
    expect(install.props.disabled).toBe(false);
    install.props.onClick?.();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0)).toEqual({
      url: "/api/skills/install-set",
      method: "POST",
      body: { skills: ["alpha/a3", "alpha/a4"] },
    });
  });

  it("pack alpha's remove button says 2 and removes exactly the two installed skills", () => {
    const [alpha] = packGroups(FIXTURE);
    const [remove] = byClass(buttons(pack(alpha)), "skset-pack-remove");

    expect(label(remove)).toBe("remove 2");
    remove.props.onClick?.();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0)).toEqual({
      url: "/api/skills/remove-set",
      method: "POST",
      body: { skills: ["alpha/a1", "alpha/a2"] },
    });
  });

  it("pack beta, nothing installed: install works, remove is disabled", () => {
    const [, beta] = packGroups(FIXTURE);
    const all = buttons(pack(beta));
    const [install] = byClass(all, "skset-pack-install");
    const [remove] = byClass(all, "skset-pack-remove");

    expect(label(install)).toBe("install 2");
    expect(install.props.disabled).toBe(false);
    expect(remove.props.disabled).toBe(true);
    install.props.onClick?.();
    expect(sent(0).body).toEqual({ skills: ["beta/b1", "beta/b2"] });
  });

  it("while any copy runs, every set button waits and the running one says so", () => {
    const [alpha, beta] = packGroups(FIXTURE);
    const running = buttons(pack(alpha, { busy: true, pendingSet: "install" }));
    const [install] = byClass(running, "skset-pack-install");
    expect(install.props.disabled).toBe(true);
    expect(label(install)).toBe(dict["skset.installing"].en);

    const other = buttons(pack(beta, { busy: true }));
    expect(byClass(other, "skset-pack-install")[0].props.disabled).toBe(true);
    expect(byClass(other, "skset-pack-remove")[0].props.disabled).toBe(true);
  });

  it("the shelf passes a running set's state to the packs it renders", async () => {
    let settle: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (settle = r)));
    const running = installSet("alpha", [row("alpha", "a3")], () => {});

    const html = renderToStaticMarkup(<CatalogueShelf catalogue={FIXTURE} lang="en" reload={() => {}} />);
    expect(html).toContain(dict["skset.installing"].en);
    expect(count(html, "skset-pack-install")).toBe(2);
    const setButtons = [...html.matchAll(/<button[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /class="[^"]*\bskset-pack-install\b/.test(tag));
    expect(setButtons).toHaveLength(2);
    expect(setButtons.every((tag) => tag.includes('disabled=""'))).toBe(true);

    settle({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response);
    await running;
  });
});

describe("criterion 4: a refused set names the refused skill and its reason", () => {
  const refused: PackRefusal = {
    pack: "alpha",
    action: "install",
    status: 409,
    refused: [{ id: "alpha/a3", reason: "Already installed. Delete it first.", status: 409, root: "user" }],
  };

  it("prints the refused id and a translated reason under that pack's header", () => {
    const [alpha] = packGroups(FIXTURE);
    const html = renderToStaticMarkup(pack(alpha, { refused }));

    expect(html).toContain("alpha/a3");
    expect(html).toContain(dict["skset.refusedTaken"].en);
    expect(html).toContain(dict["skset.setInstallRefused"].en.replace("{count}", "1"));
  });

  it("falls back to the server's own sentence for a reason it has no line for", () => {
    const [alpha] = packGroups(FIXTURE);
    const html = renderToStaticMarkup(
      pack(alpha, {
        refused: {
          ...refused,
          status: 500,
          refused: [{ id: "alpha/a4", reason: "disk gave up", status: 500 }],
        },
      }),
    );
    expect(html).toContain("alpha/a4");
    expect(html).toContain("disk gave up");
  });

  it("the shelf shows the refusal under the pack it belongs to, and only there", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: () =>
        Promise.resolve({
          refused: [{ skill: "beta/b2", status: 409, message: "Already installed.", root: "user" }],
        }),
    });
    await installSet("beta", [row("beta", "b1"), row("beta", "b2")], () => {});

    const html = renderToStaticMarkup(<CatalogueShelf catalogue={FIXTURE} lang="en" reload={() => {}} />);
    expect(html).toContain("beta/b2");
    expect(html.indexOf("beta/b2")).toBeGreaterThan(html.indexOf(">beta<"));
    expect(count(html, "skset-pack-refused")).toBe(1);
  });
});

describe("a set that stopped with skills left behind", () => {
  it("does not say nothing was installed, and names the copy that stayed", () => {
    const [alpha] = packGroups(FIXTURE);
    const html = renderToStaticMarkup(
      pack(alpha, {
        refused: {
          pack: "alpha",
          action: "install",
          status: 500,
          refused: [{ id: "alpha/a4", reason: "disk gave up", status: 500 }],
          leftover: ["alpha/a3"],
        },
      }),
    );

    expect(html).toContain(dict["skset.setStopped"].en.replace("{count}", "1"));
    expect(html).toContain("disk gave up");
    expect(html).toContain(dict["skset.setInstallLeftover"].en);
    expect(html).toContain("alpha/a3");
    expect(html).not.toContain(dict["skset.setInstallRefused"].en.replace("{count}", "1"));
  });

  it("for a remove, names what is out of the root and the folder it waits in", () => {
    const [alpha] = packGroups(FIXTURE);
    const html = renderToStaticMarkup(
      pack(alpha, {
        lang: "de",
        refused: {
          pack: "alpha",
          action: "remove",
          status: 500,
          refused: [{ id: "alpha/a2", reason: "the disk said no", status: 500 }],
          leftover: ["alpha/a1"],
          holding: "/home/someone/.spectro/.skill-remove/42",
        },
      }),
    );

    expect(html).toContain(dict["skset.setStopped"].de.replace("{count}", "1"));
    expect(html).toContain(dict["skset.setRemoveLeftover"].de);
    expect(html).toContain("alpha/a1");
    expect(html).toContain(
      dict["skset.setRemoveHolding"].de.replace("{path}", "/home/someone/.spectro/.skill-remove/42"),
    );
    expect(html).not.toContain(dict["skset.setRemoveRefused"].de.replace("{count}", "1"));
  });
});

describe("criterion 6: expanded, each skill keeps its own switch", () => {
  it("shows the four rows, each with an on and off switch reading installed", () => {
    const [alpha] = packGroups(FIXTURE);
    const element = pack(alpha, { open: true });
    const html = renderToStaticMarkup(element);
    const switches = buttons(element).filter((b) => b.props.role === "switch");

    expect(count(html, "skset-row")).toBe(4);
    expect(switches.map((s) => s.props["aria-checked"])).toEqual([true, true, false, false]);
    // The row keeps the shape card 411 builds on: name, pack chip, description, control.
    expect(html).toMatch(
      /<li class="skset-row"><span class="skset-name mono">a1<\/span><span class="wsg-scope-tag">alpha<\/span><span class="skset-desc"[^>]*>a1 does one thing.<\/span><button/,
    );
  });

  it("switching one installed row off deletes only that skill, through today's delete path", async () => {
    const reload = vi.fn();
    const [alpha] = packGroups(FIXTURE);
    const switches = buttons(pack(alpha, { open: true, reload })).filter((b) => b.props.role === "switch");

    switches[0].props.onClick?.();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0)).toEqual({ url: "/api/skills/alpha/a1", method: "DELETE", body: undefined });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it("switching a missing row on installs only that skill, through today's install path", () => {
    const [alpha] = packGroups(FIXTURE);
    const switches = buttons(pack(alpha, { open: true })).filter((b) => b.props.role === "switch");

    switches[2].props.onClick?.();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent(0)).toEqual({ url: "/api/skills/install", method: "POST", body: { skill: "alpha/a3" } });
  });

  it("after the server's next read, the header drops to 1 of 4 and the other rows are unchanged", () => {
    const after = FIXTURE.map((r) => (r.id === "alpha/a1" ? { ...r, installed: false, root: null } : r));
    const [alpha] = packGroups(after);
    const element = pack(alpha, { open: true });

    expect(renderToStaticMarkup(element)).toContain("1 of 4 installed");
    expect(
      buttons(element)
        .filter((b) => b.props.role === "switch")
        .map((s) => s.props["aria-checked"]),
    ).toEqual([false, true, false, false]);
  });

  it("a row's off switch holds the store while its DELETE runs, and every set button waits", async () => {
    let settle: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (settle = r)));
    const reload = vi.fn();
    const [alpha] = packGroups(FIXTURE);
    const switches = buttons(pack(alpha, { open: true, reload })).filter((b) => b.props.role === "switch");

    switches[0].props.onClick?.();
    expect(rowRemoval()).toBe("alpha/a1");

    const html = renderToStaticMarkup(<CatalogueShelf catalogue={FIXTURE} lang="en" reload={() => {}} />);
    const setButtons = [...html.matchAll(/<button[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /class="[^"]*\bskset-pack-(install|remove)\b/.test(tag));
    expect(setButtons).toHaveLength(4);
    expect(setButtons.every((tag) => tag.includes('disabled=""'))).toBe(true);

    settle({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(rowRemoval()).toBeNull();
  });

  it("the row being removed says so on its switch", () => {
    const [alpha] = packGroups(FIXTURE);
    const html = renderToStaticMarkup(pack(alpha, { open: true, busy: true, removingId: "alpha/a1" }));
    const titles = [
      ...html.matchAll(/role="switch"[^>]*title="([^"]*)"|title="([^"]*)"[^>]*role="switch"/g),
    ].map((m) => m[1] ?? m[2]);

    expect(titles).toHaveLength(4);
    expect(titles[0]).toBe(dict["skset.removing"].en);
    expect(titles[1]).not.toBe(dict["skset.removing"].en);
  });

  it("a project-root copy shows on but cannot be switched off from here", () => {
    const [alpha] = packGroups([row("alpha", "p1", "project")]);
    const [only] = buttons(pack(alpha, { open: true })).filter((b) => b.props.role === "switch");

    expect(only.props["aria-checked"]).toBe(true);
    expect(only.props.disabled).toBe(true);
  });
});

describe("criterion 7: the count is read, not remembered", () => {
  it("follows the rows it is given: the same shelf over a newer read shows the newer count", () => {
    const before = renderToStaticMarkup(<CatalogueShelf catalogue={FIXTURE} lang="en" reload={() => {}} />);
    const later = FIXTURE.map((r) =>
      r.id === "beta/b1" ? { ...r, installed: true, root: "user" as const } : r,
    );
    const after = renderToStaticMarkup(<CatalogueShelf catalogue={later} lang="en" reload={() => {}} />);

    expect(before).toContain("0 of 2 installed");
    expect(after).toContain("1 of 2 installed");
    expect(after).not.toContain("0 of 2 installed");
  });
});

describe("the copy", () => {
  it("the catalogue note describes the pack buttons and the row switch, and carries no remembered count", () => {
    // The count moves whenever a pack is re-vendored; the pack headers read it
    // live, so the note above them names no number at all.
    const note = dict["skset.catalogueNote"];

    expect(note.en).toContain("not installed yet");
    expect(note.en).toContain("remove button");
    expect(note.en).toContain("one skill with its switch");
    expect(note.de).toContain("noch nicht installierten");
    expect(note.de).toContain("Entfernen-Knopf");
    expect(note.de).toContain("genau einen Skill");
    for (const lang of ["de", "en"] as const) {
      expect(note[lang], lang).not.toMatch(/\d/);
      expect(note[lang], lang).not.toMatch(/[–—]/);
    }
  });

  it("has German and English for every new key, and no dash character in either", () => {
    for (const key of [
      "skset.packCount",
      "skset.packInstall",
      "skset.packRemove",
      "skset.packInstallTitle",
      "skset.packRemoveTitle",
      "skset.removing",
      "skset.rowRemoveTitle",
      "skset.rowProjectTitle",
      "skset.setInstallRefused",
      "skset.setRemoveRefused",
      "skset.refusedTaken",
      "skset.refusedProject",
      "skset.setStopped",
      "skset.setInstallLeftover",
      "skset.setRemoveLeftover",
      "skset.setRemoveHolding",
    ]) {
      expect(dict[key], key).toBeDefined();
      for (const lang of ["de", "en"] as const) {
        expect(dict[key][lang], `${key}.${lang}`).toBeTruthy();
        expect(dict[key][lang], `${key}.${lang}`).not.toMatch(/[–—]/);
      }
    }
  });
});
