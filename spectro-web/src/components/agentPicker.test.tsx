// Card 593: the picker over the agents of the session, driven without a DOM.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo } from "../state/reducer";
import { shownAgentOf } from "../state/shownAgent";
import { AgentPicker, AgentPickerView } from "./AgentPicker";
import { clipTask, pickerKey, pickerRows, TASK_CLIP } from "./agentPickerModel";
import { setLang } from "../state/lang";
import { drive, type El } from "../testkit/driveComponent";

afterEach(() => setLang("en"));

const row = (id: string, parentId: string | null, extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  parentId,
  label: null,
  task: "",
  state: "working",
  lastStatus: null,
  inTokens: 0,
  outTokens: 0,
  ...extra,
});
const agents = [
  row("main", null),
  row("explore-1", "main", {
    task: "read the plan and list every open question of the owner",
    state: "working",
  }),
  row("worker-2", "main", { label: "build_plan", task: "write it", state: "completed" }),
  row("session-title", null),
];
const state = { rootAgentId: "main", agents };
const root = shownAgentOf(state, null);
const key = (k: string) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() });

describe("the rows", () => {
  it("list the root first, then every helper in roster order, and leave parentless pseudo agents out", () => {
    const rows = pickerRows(agents, root);
    expect(rows.map((r) => r.id)).toEqual([null, "explore-1", "worker-2"]);
    expect(rows[1]).toMatchObject({ working: true, ended: false, label: null });
    expect(rows[2]).toMatchObject({ working: false, ended: true, label: "build_plan", task: "write it" });
  });

  it("clip the task at 40 characters", () => {
    expect(TASK_CLIP).toBe(40);
    expect(clipTask("x".repeat(40))).toBe("x".repeat(40));
    expect(clipTask("x".repeat(41))).toBe("x".repeat(40) + "…");
    expect(pickerRows(agents, root)[1].task).toHaveLength(41);
  });
});

describe("the keys", () => {
  it("ArrowDown opens a closed list and is handled; another key is not", () => {
    expect(pickerKey({ open: false, index: 0 }, "ArrowDown", 3)).toEqual({
      state: { open: true, index: 0 },
      pick: null,
      handled: true,
    });
    expect(pickerKey({ open: false, index: 0 }, "a", 3).handled).toBe(false);
  });

  it("Escape with the list closed is not handled, so the popover's own listener may act", () => {
    expect(pickerKey({ open: false, index: 1 }, "Escape", 3)).toEqual({
      state: { open: false, index: 1 },
      pick: null,
      handled: false,
    });
  });

  it("Escape with the list open closes it and is handled", () => {
    expect(pickerKey({ open: true, index: 1 }, "Escape", 3)).toEqual({
      state: { open: false, index: 1 },
      pick: null,
      handled: true,
    });
  });

  it("the arrows, Home and End move through nextMenuIndex and wrap", () => {
    expect(pickerKey({ open: true, index: 0 }, "ArrowDown", 3).state.index).toBe(1);
    expect(pickerKey({ open: true, index: 0 }, "ArrowUp", 3).state.index).toBe(2);
    expect(pickerKey({ open: true, index: 1 }, "End", 3).state.index).toBe(2);
    expect(pickerKey({ open: true, index: 2 }, "Home", 3).state.index).toBe(0);
  });

  it("Enter picks the active row and closes", () => {
    expect(pickerKey({ open: true, index: 2 }, "Enter", 3)).toEqual({
      state: { open: false, index: 2 },
      pick: 2,
      handled: true,
    });
  });
});

describe("the markup", () => {
  const view = (shown = root, open = false, lang: "en" | "de" = "en"): string =>
    renderToStaticMarkup(
      <AgentPickerView
        lang={lang}
        rows={pickerRows(agents, shown)}
        shown={shown}
        open={open}
        index={0}
        idBase="p1"
        onToggle={() => {}}
        onKeyDown={() => {}}
        onPickRow={() => {}}
      />,
    );

  it("says what it shows, in both languages", () => {
    expect(view()).toContain("Showing: Main agent");
    expect(view(shownAgentOf(state, "explore-1"))).toContain("Showing: explore-1");
    expect(view(shownAgentOf(state, "explore-1"), false, "de")).toContain("Zeigt: explore-1");
  });

  it("is a listbox button with its rows as options, the shown one selected", () => {
    const html = view(shownAgentOf(state, "explore-1"), true);
    expect(html).toMatch(/<button[^>]*aria-haspopup="listbox"[^>]*aria-expanded="true"/);
    expect(html).toContain('role="listbox"');
    expect((html.match(/role="option"/g) ?? []).length).toBe(3);
    expect(html).toMatch(/<li[^>]*role="option"[^>]*aria-selected="true"[^>]*>(?:(?!<\/li>).)*explore-1/);
    expect(html).toContain("build_plan");
    expect(html).toContain(">ended<");
    expect(html).toContain('class="agent-dot agent-dot--working"');
  });

  it("disables the chevron with one agent and still says what it shows", () => {
    const alone = shownAgentOf({ rootAgentId: "main", agents: [agents[0]] }, null);
    const html = renderToStaticMarkup(
      <AgentPickerView
        lang="en"
        rows={pickerRows([agents[0]], alone)}
        shown={alone}
        open={false}
        index={0}
        idBase="p2"
        onToggle={() => {}}
        onKeyDown={() => {}}
        onPickRow={() => {}}
      />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Showing: Main agent");
  });

  it("names the id that is gone under the label", () => {
    const html = view(shownAgentOf(state, "worker-9"));
    expect(html).toContain("Showing: Main agent");
    expect(html).toContain("worker-9 is not in this session. Showing the main agent.");
  });
});

describe("the component", () => {
  // AgentPicker keeps the state, AgentPickerView draws; both are run as functions in the probe.
  const expand = [AgentPicker, AgentPickerView];
  const picker = (tree: El[]): El => {
    const el = tree.find((e) => e.type === "div" && String(e.props.className ?? "").startsWith("agent-pick"));
    if (el === undefined) throw new Error("no picker root in this pass");
    return el;
  };
  const list = (tree: El[]): El | undefined => tree.find((e) => e.type === "ul");
  const press = (tree: El[], k: string) => {
    const e = key(k);
    (picker(tree).props.onKeyDown as (e: ReturnType<typeof key>) => void)(e);
    return e;
  };

  it("a click opens the list, ArrowDown and Enter pick the second row, and the list closes", () => {
    const onPick = vi.fn();
    const stops: boolean[] = [];
    drive(<AgentPicker agents={agents} shown={root} onPick={onPick} />, expand, [
      (tree) => {
        expect(list(tree)).toBeUndefined();
        (tree.find((e) => e.type === "button")!.props.onClick as () => void)();
      },
      (tree) => {
        expect(list(tree)).toBeDefined();
        stops.push(press(tree, "ArrowDown").stopPropagation.mock.calls.length === 1);
      },
      (tree) => stops.push(press(tree, "Enter").stopPropagation.mock.calls.length === 1),
      (tree) => expect(list(tree)).toBeUndefined(),
    ]);
    expect(onPick).toHaveBeenCalledWith("explore-1");
    expect(stops).toEqual([true, true]);
  });

  it("Escape closes the list and stops there; a second Escape is left to the popover", () => {
    const stops: number[] = [];
    drive(<AgentPicker agents={agents} shown={root} onPick={() => {}} />, expand, [
      (tree) => (tree.find((e) => e.type === "button")!.props.onClick as () => void)(),
      (tree) => stops.push(press(tree, "Escape").stopPropagation.mock.calls.length),
      (tree) => {
        expect(list(tree)).toBeUndefined();
        stops.push(press(tree, "Escape").stopPropagation.mock.calls.length);
      },
    ]);
    expect(stops).toEqual([1, 0]);
  });

  it("a click on a row picks it; the root row picks null", () => {
    const onPick = vi.fn();
    drive(<AgentPicker agents={agents} shown={shownAgentOf(state, "worker-2")} onPick={onPick} />, expand, [
      (tree) => (tree.find((e) => e.type === "button")!.props.onClick as () => void)(),
      (tree) => {
        const rows = tree.filter((e) => e.type === "li");
        (rows[0].props.onClick as () => void)();
      },
    ]);
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("with one agent the keys leave the list closed and go on to the popover", () => {
    const alone = [agents[0]];
    const stops: number[] = [];
    drive(
      <AgentPicker
        agents={alone}
        shown={shownAgentOf({ rootAgentId: "main", agents: alone }, null)}
        onPick={() => {}}
      />,
      expand,
      [
        (tree) => stops.push(press(tree, "ArrowDown").stopPropagation.mock.calls.length),
        (tree) => expect(list(tree)).toBeUndefined(),
      ],
    );
    expect(stops).toEqual([0]);
  });
});
