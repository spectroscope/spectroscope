// Card 296, the view setting's WIRING: the segment renders beside the existing
// ones, the pick persists under its own key, and rowsPrefFrom reads it back.
// Rendered with react-dom/server like the other view suites — no DOM in this
// gate — with the canvas package stubbed and localStorage faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({ children }: { children?: ReactNode }) => <div data-mock="reactflow">{children}</div>,
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  Controls: () => null,
  MiniMap: () => null,
  Panel: ({ children }: { children?: ReactNode }) => <>{children}</>,
  ViewportPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  useReactFlow: () => ({ fitView: () => {} }),
  useNodesState: () => [[], () => {}, () => {}],
  useEdgesState: () => [[], () => {}, () => {}],
  getSmoothStepPath: () => ["M0,0 L1,1", 0, 0],
}));

import { LabView, ROWS_STORAGE_KEY, VIEW_STORAGE_KEY, persistRowsPref } from "./LabView";
import { rowsPrefFrom } from "./flowmap/workerGrid";
import { LENS_STORAGE_KEY } from "./LabView";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

const lang = currentLang();

function fakeStorage(): { store: Map<string, string>; api: Pick<Storage, "getItem" | "setItem"> } {
  const store = new Map<string, string>();
  return {
    store,
    api: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    },
  };
}

let storage: ReturnType<typeof fakeStorage>;
beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal("localStorage", storage.api);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const render = (): string =>
  renderToStaticMarkup(
    <LabView
      replay={null}
      liveEvents={[]}
      running={false}
      onSend={() => {}}
      onDecide={() => {}}
      onReturnToLive={() => {}}
      sendClient={() => true}
    />,
  );

const button = (html: string, label: string): string => {
  const m = html.match(new RegExp(`<button[^>]*>${label}</button>`));
  expect(m, `a button labelled "${label}"`).not.toBeNull();
  return (m as RegExpMatchArray)[0];
};

describe("the rows segment renders", () => {
  // The seating the preference actually steers is the EXPANDED one, so every
  // pin below opens the view the control belongs to. Live with no stored
  // choice the Lab opens COMPACT (labViewDefault), which is the state the
  // re-review caught the control shipping into.
  beforeEach(() => {
    storage.store.set(VIEW_STORAGE_KEY, "expanded");
  });

  it("offers auto, 2 and 3 with auto pressed — auto stays the default", () => {
    const html = render();
    expect(html).toContain("lab-rows-seg");
    expect(html).toContain(`aria-label="${t(lang, "lab.rowsAria")}"`);
    expect(button(html, t(lang, "lab.rowsAuto"))).toContain('aria-pressed="true"');
    expect(button(html, "2")).toContain('aria-pressed="false"');
    expect(button(html, "3")).toContain('aria-pressed="false"');
  });

  it("shows the stored choice as the pressed one", () => {
    storage.store.set(ROWS_STORAGE_KEY, "3");
    const html = render();
    expect(button(html, "3")).toContain('aria-pressed="true"');
    expect(button(html, t(lang, "lab.rowsAuto"))).toContain('aria-pressed="false"');
  });

  it("hides under the workflow lens, like the other machine-only controls", () => {
    storage.store.set(LENS_STORAGE_KEY, "workflow");
    expect(render()).not.toContain("lab-rows-seg");
  });

  // Re-review, card 296. The control shipped clickable in the compact view,
  // where sceneToFlow never reads it: the expanded branch alone passes
  // opts.rowsPref into rowsFor, compact seats from SEAT_ROWS_COMPACT. The
  // file's own doctrine nine lines above the segment says why that is worse
  // than hiding it — "a control that does nothing is the worse default (card
  // 293 re-review)" — and compact is where a live run opens.
  it("hides in the COMPACT view, where the seating never reads the preference", () => {
    storage.store.set(VIEW_STORAGE_KEY, "compact");
    expect(render()).not.toContain("lab-rows-seg");
  });

  // The guard is on the view, not on the lens: the face segment beside it is
  // machine-only but view-independent and must survive the same render.
  it("leaves the other machine-only segments alone in compact", () => {
    storage.store.set(VIEW_STORAGE_KEY, "compact");
    const html = render();
    expect(html).toContain("lab-face-seg");
    expect(html).toContain("lab-view-seg");
  });
});

describe("the rows pick persists", () => {
  it("writes under 'spectroscope.lab.rows', and rowsPrefFrom reads it back", () => {
    persistRowsPref(3);
    expect(storage.store.get("spectroscope.lab.rows")).toBe("3");
    expect(rowsPrefFrom(storage.api.getItem(ROWS_STORAGE_KEY))).toBe(3);
    persistRowsPref("auto");
    expect(rowsPrefFrom(storage.api.getItem(ROWS_STORAGE_KEY))).toBe("auto");
  });

  it("survives a missing storage instead of throwing (private mode)", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(() => persistRowsPref(2)).not.toThrow();
  });
});

describe("both locales carry the setting", () => {
  it("every key the segment prints is translated, EN and DE, and they differ where they must", () => {
    for (const key of [
      "lab.rows",
      "lab.rowsAria",
      "lab.rowsHint",
      "lab.rowsAuto",
      "lab.rowsAutoTitle",
      "lab.rows2Title",
      "lab.rows3Title",
    ]) {
      for (const l of ["en", "de"] as const) {
        expect(t(l, key), `${key}/${l}`).not.toBe(key);
        expect(t(l, key).length, `${key}/${l}`).toBeGreaterThan(0);
      }
    }
    expect(t("de", "lab.rowsHint")).not.toBe(t("en", "lab.rowsHint"));
    expect(t("de", "lab.rows")).not.toBe(t("en", "lab.rows"));
  });
});
