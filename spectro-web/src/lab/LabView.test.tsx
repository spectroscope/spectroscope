// The Lab's lens WIRING (card 293 re-review): the lens segment renders, the
// pick persists under its own key, and the workflow choice swaps the centre
// projection. Rendered with react-dom/server like the other view suites — no
// DOM in this gate — with the canvas package stubbed and localStorage faked.
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

import { LabView, LENS_STORAGE_KEY, persistLens } from "./LabView";
import type { WorkflowDeclaration } from "./workflowGraph";
import { lensFrom } from "./workflow/WorkflowLens";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

const lang = currentLang();

/** A Map-backed localStorage double — the gate has no browser storage. */
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

/** The one <button> whose text is `label` — asserted on its attributes by
 *  MEANING, not by attribute order (the documented attribute-order trap). */
const button = (html: string, label: string): string => {
  const m = html.match(new RegExp(`<button[^>]*>${label}</button>`));
  expect(m, `a button labelled "${label}"`).not.toBeNull();
  return (m as RegExpMatchArray)[0];
};

describe("the lens segment renders", () => {
  it("shows both lens choices, the machine lens pressed by default", () => {
    const html = render();
    expect(html).toContain(`aria-label="${t(lang, "lab.lensAria")}"`);
    expect(button(html, t(lang, "lab.lensMachine"))).toContain('aria-pressed="true"');
    expect(button(html, t(lang, "lab.lensWorkflow"))).toContain('aria-pressed="false"');
  });
});

describe("the pick persists", () => {
  it("writes the choice under 'spectroscope.lab.lens', and lensFrom reads it back", () => {
    persistLens("workflow");
    expect(storage.store.get("spectroscope.lab.lens")).toBe("workflow");
    expect(lensFrom(storage.api.getItem(LENS_STORAGE_KEY))).toBe("workflow");
    persistLens("machine");
    expect(lensFrom(storage.api.getItem(LENS_STORAGE_KEY))).toBe("machine");
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
    expect(() => persistLens("workflow")).not.toThrow();
  });
});

describe("the lens swaps the projection", () => {
  it("renders the machine map while nothing is stored", () => {
    const html = render();
    expect(html).toContain('class="lab-flowmap"');
    expect(html).not.toContain('class="wf-lens"');
  });

  it("renders the workflow lens in place of the machine map once stored", () => {
    storage.store.set(LENS_STORAGE_KEY, "workflow");
    const html = render();
    expect(html).toContain('class="wf-lens"');
    expect(html).not.toContain('class="lab-flowmap"');
  });
});

describe("machine-only controls hide under the workflow lens", () => {
  // The face (insight/structured) and compact/expanded segments only affect
  // the machine lens — a control that does nothing is the worse default, so
  // they disappear while lens === 'workflow'. Hiding is a one-liner and
  // reversible if the owner later wants them on this lens too.
  it("shows face and view segments on the machine lens", () => {
    const html = render();
    expect(html).toContain("lab-face-seg");
    expect(html).toContain("lab-view-seg");
  });

  it("hides them on the workflow lens, while the lens segment itself stays", () => {
    storage.store.set(LENS_STORAGE_KEY, "workflow");
    const html = render();
    expect(html).toContain("lab-lens-seg");
    expect(html).not.toContain("lab-face-seg");
    expect(html).not.toContain("lab-view-seg");
  });
});

/**
 * THE OUTER SEAM (card 302 re-review). Everything else about the declared
 * picture is pinned one layer down, on a lens handed a declaration by hand.
 * Nothing held that the LAB hands the OPEN RUN's declaration to that lens:
 * dropping `declared={replay?.declared}` left the entire suite green while a
 * declared workflow drew as a guess. Rendered like the pins above — the effect
 * that loads the replay does not run under react-dom/server, which is exactly
 * why the declared columns a run never filled are the visible half here.
 */
describe("the Lab hands the open run's declaration to the lens", () => {
  const DECL: WorkflowDeclaration = new Map([
    [
      "main",
      {
        phases: [
          { title: "a-declared-column", detail: null, members: [] },
          { title: "another-one", detail: null, members: [] },
        ],
        unplaced: [],
      },
    ],
  ]);

  const withReplay = (declared?: WorkflowDeclaration): string => {
    storage.store.set(LENS_STORAGE_KEY, "workflow");
    return renderToStaticMarkup(
      <LabView
        replay={{ id: "import:one", events: [], ...(declared !== undefined ? { declared } : {}) }}
        liveEvents={[]}
        running={false}
        onSend={() => {}}
        onDecide={() => {}}
        onReturnToLive={() => {}}
        sendClient={() => true}
      />,
    );
  };

  it("draws the declared columns and says declared", () => {
    const html = withReplay(DECL);
    expect(html).toContain(t(lang, "lab.lens.legendDeclared"));
    expect(html).toContain(t(lang, "lab.lens.sourceDeclared"));
    expect(html).toContain("a-declared-column");
    expect(html).toContain("another-one");
  });

  it("says recovered, and names no column, for a run that declared nothing", () => {
    const html = withReplay();
    expect(html).not.toContain(t(lang, "lab.lens.legendDeclared"));
    expect(html).toContain(t(lang, "lab.lens.sourceRecovered"));
    expect(html).not.toContain("wf-ranklabel");
  });
});
