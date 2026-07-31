import { describe, it, expect } from "vitest";
import { SHELL_MAX_TABS, emptyTabs, openTab, closeTab, selectTab, retitleTab, tabLabel } from "./shellTabs";

describe("openTab", () => {
  it("opens the first tab and makes it active", () => {
    const state = openTab(emptyTabs());
    expect(state.tabs).toHaveLength(1);
    expect(state.active).toBe(state.tabs[0].id);
  });

  it("never reuses an id, so a closed tab's socket cannot adopt a new pane", () => {
    const one = openTab(emptyTabs());
    const two = openTab(one);
    const afterClose = closeTab(two, one.tabs[0].id);
    const three = openTab(afterClose);
    const ids = [one.tabs[0].id, two.tabs[1].id, three.tabs[three.tabs.length - 1].id];
    expect(new Set(ids).size).toBe(3);
  });

  it("stops at the cap the server enforces per session", () => {
    let state = emptyTabs();
    for (let i = 0; i < SHELL_MAX_TABS + 3; i++) state = openTab(state);
    expect(state.tabs).toHaveLength(SHELL_MAX_TABS);
  });
});

describe("closeTab", () => {
  it("removes the tab", () => {
    const two = openTab(openTab(emptyTabs()));
    const state = closeTab(two, two.tabs[0].id);
    expect(state.tabs.map((tab) => tab.id)).toEqual([two.tabs[1].id]);
  });

  it("moves the selection to the neighbour when the active tab closes", () => {
    const three = openTab(openTab(openTab(emptyTabs())));
    const state = closeTab({ ...three, active: three.tabs[1].id }, three.tabs[1].id);
    expect(state.active).toBe(three.tabs[2].id);
  });

  it("falls back to the previous tab when the last one closes", () => {
    const two = openTab(openTab(emptyTabs()));
    const state = closeTab({ ...two, active: two.tabs[1].id }, two.tabs[1].id);
    expect(state.active).toBe(two.tabs[0].id);
  });

  it("leaves no active tab when the pane empties", () => {
    const one = openTab(emptyTabs());
    const state = closeTab(one, one.tabs[0].id);
    expect(state.tabs).toEqual([]);
    expect(state.active).toBeNull();
  });

  it("keeps the selection when some other tab closes", () => {
    const three = openTab(openTab(openTab(emptyTabs())));
    const state = closeTab({ ...three, active: three.tabs[0].id }, three.tabs[2].id);
    expect(state.active).toBe(three.tabs[0].id);
  });

  it("ignores an id that is not open", () => {
    const one = openTab(emptyTabs());
    expect(closeTab(one, 9999)).toEqual(one);
  });
});

describe("selectTab", () => {
  it("selects an open tab", () => {
    const two = openTab(openTab(emptyTabs()));
    expect(selectTab(two, two.tabs[0].id).active).toBe(two.tabs[0].id);
  });

  it("refuses an id that is not open", () => {
    const one = openTab(emptyTabs());
    expect(selectTab(one, 9999)).toEqual(one);
  });
});

describe("retitleTab", () => {
  it("stores the title the shell reported", () => {
    const one = openTab(emptyTabs());
    const state = retitleTab(one, one.tabs[0].id, "~/spectro");
    expect(state.tabs[0].title).toBe("~/spectro");
  });

  it("returns the same state when nothing changed, so React skips the render", () => {
    const one = retitleTab(openTab(emptyTabs()), 1, "x");
    expect(retitleTab(one, one.tabs[0].id, "x")).toBe(one);
  });
});

describe("tabLabel", () => {
  it("numbers a tab that never reported a title", () => {
    expect(tabLabel({ id: 7 }, 0)).toBe("1");
    expect(tabLabel({ id: 7 }, 4)).toBe("5");
  });

  it("prefers the title the shell set", () => {
    expect(tabLabel({ id: 1, title: "vim README.md" }, 0)).toBe("vim README.md");
  });

  it("numbers a tab whose title is only whitespace", () => {
    expect(tabLabel({ id: 1, title: "   " }, 2)).toBe("3");
  });

  it("truncates a long title so one tab cannot eat the strip", () => {
    expect(tabLabel({ id: 1, title: "a".repeat(40) }, 0)).toBe(`${"a".repeat(17)}…`);
  });
});
