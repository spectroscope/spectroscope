// Card 195, review finding 1, held where the defect actually lived: the wiring.
// Read off disk (house rule: no renderer in this tree).
//
// The logic module already knew everything. `HooksView.effective` was built by
// the server, typed on the client, covered by a fixture — and never drawn.
// `HooksSettings` declared a `session` prop, documented it as "the session whose
// workspace scopes join the read", and was mounted without it, so the endpoint's
// `?session=` was never sent and the workspace layers were never fetched. Every
// unit test passed throughout. The page listed one hook while a different hook
// blocked every tool call in the session open beside it.
//
// That is the bug class a source read catches and nothing else here can: a page
// that computes the right answer and renders the wrong one, and a prop that
// documents a connection nobody made. Each expectation below names one link in
// the chain from App.tsx to the fetch.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** @return a source file in this tree, as text */
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const hooksTsx = read("./HooksSettings.tsx");
const settingsTsx = read("./SettingsPanel.tsx");
const appTsx = read("../App.tsx");

/** The one JSX element that mounts a component, from its tag to the closing
 *  slash — so an expectation about a prop cannot be satisfied by that prop
 *  appearing somewhere else entirely in the file.
 *  @param source the file text
 *  @param tag the component name
 *  @return the mount element's text */
function mount(source: string, tag: string): string {
  const at = source.indexOf(`<${tag}`);
  expect(at, `${tag} is not mounted`).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf("/>", at) + 2);
}

describe("the hooks page answers for the run in front of the reader", () => {
  it("draws the folded list, not only the per-scope ones", () => {
    // The finding itself. `effective` used to appear in the type and the test
    // fixture and nowhere else.
    expect(hooksTsx).toContain("inForce(view)");
    expect(hooksTsx).toContain("hooks-in-force");
  });

  it("says which layer is in force and which layers it silenced", () => {
    // hooks is a whole-block field. A page listing the scopes without saying
    // that the top one REPLACES the rest invites the reader to add them up.
    expect(hooksTsx).toContain("hooksOrigin(view)");
    expect(hooksTsx).toContain("scopeIsInForce(");
    expect(hooksTsx).toContain("set.hkShadowed");
  });

  it("says whether the answer covers a running session or only this machine", () => {
    expect(hooksTsx).toContain("reachKey(view)");
  });

  it("asks the endpoint for the session, which is the whole reason it takes one", () => {
    expect(hooksTsx).toContain("?session=");
    expect(mount(settingsTsx, "HooksSettings")).toContain("session={session}");
    expect(mount(appTsx, "SettingsPanel")).toContain("session={");
  });

  it("falls back to the machine-wide answer for a session with no workspace", () => {
    // resolveWorkspace answers 404 for a session that has neither a pinned nor a
    // configured workspace. Treating that as "the hook list could not be read"
    // would replace a true answer with a failure line.
    expect(hooksTsx).toContain("res.status === 404");
  });
});
