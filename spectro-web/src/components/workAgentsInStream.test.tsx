// Card 313: a loaded agent is not an external file.
//
// Card 297 gave an imported workflow run a NODE in the stream with the run's
// agents hanging under it, and the agents panel lists them like any other
// agent. The work panel went on saying the opposite about the SAME agents on
// the SAME screen: "none of them in this stream", and a row of file names with
// byte sizes beside it.
//
// So this is a CONDITION, never a deletion. Both arms are pinned separately:
// where the agents really are absent — a session imported without its
// sidecars, a run id that never resolved — the old sentence is the correct
// reading of that file and stays verbatim.
//
// The presence question is answered from the agents panel's OWN roster
// (UiState.agents, typed AgentInfo here so the compiler holds it to that), not
// from a second derivation: two folds disagreeing about one fact is what
// produced this defect.

import { describe, expect, it, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { absences, besideReading } from "./workLevels";
import { WorkPanel } from "./WorkPanel";
import type { WorkItem } from "../state/work";
import type { AgentInfo } from "../state/reducer";
import type { SidecarAgent, SidecarIndex } from "../import/sidecarAgents";
import { NO_SIDECARS } from "../import/sidecarAgents";
import { setLang } from "../state/lang";

afterEach(() => setLang("en"));

const RUN = "wf_313";
const NODE = "toolu_launch";

function child(id: string): WorkItem {
  return {
    id,
    parentId: NODE,
    kind: "spawn",
    name: id,
    intent: "",
    state: "completed",
    lastStatus: null,
    firstTs: 110,
    lastTs: 190,
    inTokens: 10,
    outTokens: 20,
    toolCalls: 1,
    gatesAsked: 0,
    gatesDenied: 0,
    gatePending: false,
    model: null,
    provider: null,
    opaque: null,
    runId: null,
    evidence: { start: null, tokens: null, firstCall: null, denial: null, end: null },
    children: [],
  };
}

/** The launch row: a Workflow tool_use that reported three agents. */
function launchNode(over: Partial<WorkItem> = {}): WorkItem {
  return {
    ...child(NODE),
    id: NODE,
    parentId: "main",
    name: "Workflow",
    state: "completed",
    firstTs: 100,
    lastTs: 200,
    // The node itself spends nothing and calls nothing: the work happened in
    // its children, which is exactly why the row used to read as empty.
    inTokens: 0,
    outTokens: 0,
    toolCalls: 0,
    opaque: { agents: 3, agentsDone: 3, agentsError: 0, toolUses: 12, durationMs: 900 },
    runId: RUN,
    children: [child("a1"), child("a2"), child("a3")],
    ...over,
  };
}

const file = (agentId: string): SidecarAgent => ({
  agentId,
  path: `subagents/workflows/${RUN}/agent-${agentId}.jsonl`,
  runId: RUN,
  bytes: 43_008,
  modifiedAt: 1,
});

const index = (files: SidecarAgent[]): SidecarIndex => ({
  all: files,
  forRun: (runId) => files.filter((f) => f.runId === runId),
  byAgentId: (id) => files.find((f) => f.agentId === id),
});

/** The agents panel's own roster: the run's node and its three agents. */
const roster: AgentInfo[] = ["a1", "a2", "a3"].map((id) => ({
  id,
  parentId: NODE,
  label: "workflow",
  task: "",
  state: "completed",
  lastStatus: null,
  inTokens: 10,
  outTokens: 20,
}));

const FILES = [file("a1"), file("a2"), file("a3")];

describe("besideReading — the one fact, read from the agents panel's roster", () => {
  it("agents PRESENT: the row reads them as agents, never as files", () => {
    const reading = besideReading(launchNode(), roster, index(FILES));
    expect(reading?.kind).toBe("inStream");
    expect(reading).toEqual({ kind: "inStream", agents: ["a1", "a2", "a3"], claimed: 3 });
  });

  it("agents ABSENT but the transcripts are on disk: the file list, unchanged", () => {
    const reading = besideReading(launchNode(), [], index(FILES));
    expect(reading?.kind).toBe("files");
    expect(reading).toEqual({ kind: "files", files: FILES, claimed: 3 });
  });

  it("agents ABSENT and no files: the receipt's own claim, unchanged", () => {
    const reading = besideReading(launchNode(), [], NO_SIDECARS);
    expect(reading).toEqual({ kind: "claim", claimed: 3, toolUses: 12 });
  });

  it("the roster is asked about THIS item — another node's agents are not this row's", () => {
    const elsewhere: AgentInfo[] = roster.map((a) => ({ ...a, parentId: "toolu_other" }));
    expect(besideReading(launchNode(), elsewhere, index(FILES))?.kind).toBe("files");
  });

  it("says nothing at all about an ordinary lane — no receipt, no run id", () => {
    const lane = child("plain");
    expect(besideReading(lane, roster, index(FILES))).toBeNull();
  });

  it("a run whose id never resolved keeps the claim, agents or not", () => {
    // The receipt printed no Run ID, so no folder can be named and no agent of
    // it is in the stream under this node.
    expect(besideReading(launchNode({ runId: null, children: [] }), [], NO_SIDECARS)).toEqual({
      kind: "claim",
      claimed: 3,
      toolUses: 12,
    });
  });
});

describe("absences — the same condition on the neighbouring sentence", () => {
  it("agents ABSENT: the per-agent rows are missing, and it says so", () => {
    expect(absences({ ...launchNode(), kind: "launched", children: [] }, false)).toContain("agentRows");
  });

  it("agents PRESENT: nothing of the launch is claimed to be elsewhere", () => {
    // Not only the per-agent rows: the tokens and the calls are in the stream
    // too, under the children this row can open.
    expect(absences({ ...launchNode(), kind: "launched" }, true)).toEqual([]);
  });

  it("agents ABSENT: a node that spent nothing itself is a lane with nothing recorded", () => {
    expect(absences(launchNode(), false)).toContain("noWork");
  });

  it("agents PRESENT: 'nothing of this lane' is false and is not printed", () => {
    expect(absences(launchNode(), true)).not.toContain("noWork");
  });

  it("the span is still measured either way", () => {
    expect(absences(launchNode({ firstTs: null }), true)).toContain("span");
    expect(absences(launchNode({ firstTs: null }), false)).toContain("span");
  });
});

function panel(extra: {
  roster?: AgentInfo[];
  sidecars?: SidecarIndex;
  item?: WorkItem;
}): string {
  return renderToStaticMarkup(
    <WorkPanel
      items={[extra.item ?? launchNode()]}
      liveView={false}
      roster={extra.roster ?? []}
      sidecars={extra.sidecars ?? NO_SIDECARS}
      onOpenAgent={() => {}}
    />,
  );
}

describe("the work panel on screen — the two arms, seen", () => {
  it("agents present: no byte size, no 'not in this stream'", () => {
    const html = panel({ roster, sidecars: index(FILES) });
    expect(html).not.toContain("kB");
    expect(html).not.toContain("none of them in this stream");
    expect(html).not.toContain("not in this stream");
    expect(html).not.toContain("agent transcripts sit beside this file");
    expect(html).toContain("3 agents of this run are in this stream");
  });

  it("agents present: the run's agents are still countable as agents", () => {
    // The children toggle the panel has always drawn — the rows the reader
    // opens instead of a file list.
    const html = panel({ roster, sidecars: index(FILES) });
    expect(html).toContain('class="work-toggle"');
    expect(html).toContain("3 agents</button>");
  });

  it("agents absent, transcripts on disk: the file list stands, byte sizes and all", () => {
    const html = panel({ roster: [], sidecars: index(FILES) });
    expect(html).toContain("agent transcripts sit beside this file");
    expect(html).toContain("kB");
  });

  it("agents absent, nothing on disk: the refusal stands verbatim", () => {
    const html = panel({ roster: [], sidecars: NO_SIDECARS });
    expect(html).toContain("none of them in this stream");
    expect(html).toContain("reports 12 tool calls");
  });

  it("the claim is still shown when it disagrees with what is in the stream", () => {
    const html = panel({
      roster: roster.slice(0, 2),
      sidecars: index(FILES),
      item: launchNode({ children: [child("a1"), child("a2")] }),
    });
    expect(html).toContain("2 agents of this run are in this stream");
    expect(html).toContain("the task reported 3");
  });

  it("and it is not shown when the two agree", () => {
    expect(panel({ roster, sidecars: index(FILES) })).not.toContain("the task reported");
  });

  it("German says both arms too", () => {
    setLang("de");
    expect(panel({ roster, sidecars: index(FILES) })).toContain(
      "3 Agenten dieses Laufs stehen in diesem Stream",
    );
    expect(panel({ roster: [], sidecars: NO_SIDECARS })).toContain("keiner davon in diesem Stream");
  });

  it("one agent reads as one, in both locales", () => {
    const one = { item: launchNode({ children: [child("a1")] }), roster: roster.slice(0, 1) };
    expect(panel(one)).toContain("1 agent of this run is in this stream");
    setLang("de");
    expect(panel(one)).toContain("1 Agent dieses Laufs steht in diesem Stream");
  });
});
