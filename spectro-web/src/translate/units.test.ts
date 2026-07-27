import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { applyUnits, extractUnits } from "./units";

const ts = 1;

/** A run_start with the fields these tests care about. */
const start = (prompt: string, agentId = "main", parentId?: string): RunEvent => ({
  type: "run_start",
  runId: "r1",
  agentId,
  prompt,
  ...(parentId !== undefined ? { parentId } : {}),
  ts,
});

const delta = (agentId: string, text: string): RunEvent => ({ type: "text_delta", agentId, text, ts });
const think = (agentId: string, text: string): RunEvent => ({ type: "thinking_delta", agentId, text, ts });

const call = (agentId: string, callId: string, input: unknown): RunEvent => ({
  type: "tool_call",
  agentId,
  callId,
  name: "run_command",
  input,
  ts,
});

const result = (agentId: string, callId: string, output: string): RunEvent => ({
  type: "tool_result",
  agentId,
  callId,
  output,
  isError: false,
  durationMs: 3,
  ts,
});

describe("extractUnits — what a translation is allowed to touch", () => {
  it("takes the prompt, the answer and an agent message, and nothing else", () => {
    const events: RunEvent[] = [
      start("чому небо блакитне?"),
      think("main", "The user asks about physics."),
      call("main", "c1", { cmd: "ls -la /etc" }),
      result("main", "c1", "total 4\ndrwxr-xr-x"),
      { type: "error", agentId: "main", message: "java.io.IOException: broken pipe", ts },
      delta("main", "Because short wavelengths scatter."),
      {
        type: "agent_message",
        from: "main",
        to: "worker-1",
        role: "task",
        state: "submitted",
        text: "Review the auth module.",
        ts,
      },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts },
    ];

    expect(extractUnits(events)).toEqual([
      { id: "0:prompt", kind: "prompt", text: "чому небо блакитне?" },
      { id: "5:text", kind: "answer", text: "Because short wavelengths scatter." },
      { id: "6:text", kind: "message", text: "Review the auth module." },
    ]);
  });

  it("never carries a command, a tool's output or an error frame", () => {
    const events: RunEvent[] = [
      start("go"),
      call("main", "c1", { cmd: "rm -rf /tmp/build" }),
      result("main", "c1", "deleted 42 files"),
      { type: "error", agentId: "main", message: "ENOENT: no such file", ts },
    ];
    const carried = extractUnits(events)
      .map((u) => u.text)
      .join("\n");

    expect(carried).toBe("go");
    expect(carried).not.toContain("rm -rf");
    expect(carried).not.toContain("deleted 42 files");
    expect(carried).not.toContain("ENOENT");
  });

  it("takes a child's run_start prompt too — it is what the parent asked", () => {
    const events: RunEvent[] = [start("root task"), start("child task", "worker-1", "main")];

    expect(extractUnits(events).map((u) => u.id)).toEqual(["0:prompt", "1:prompt"]);
  });

  it("drops a field that is blank or whitespace only", () => {
    const events: RunEvent[] = [start(""), delta("main", "   \n  ")];

    expect(extractUnits(events)).toEqual([]);
  });

  it("ignores an event type it does not know", () => {
    const events = [
      { type: "provider_info", model: "claude-opus-5", ts } as unknown as RunEvent,
      start("hello"),
    ];

    expect(extractUnits(events).map((u) => u.id)).toEqual(["1:prompt"]);
  });

  it("gives every unit an id no other unit has", () => {
    const events: RunEvent[] = [
      start("p"),
      delta("main", "a"),
      call("main", "c1", {}),
      delta("main", "b"),
      think("main", "t"),
    ];
    const ids = extractUnits(events, { thinking: true }).map((u) => u.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("extractUnits — the delta stream is one unit, not ten", () => {
  it("joins consecutive deltas of one agent into a single unit anchored at the first", () => {
    const events: RunEvent[] = [
      start("q"),
      delta("main", "Because "),
      delta("main", "short "),
      delta("main", "wavelengths "),
      delta("main", "scatter."),
    ];

    expect(extractUnits(events)).toEqual([
      { id: "0:prompt", kind: "prompt", text: "q" },
      { id: "1:text", kind: "answer", text: "Because short wavelengths scatter." },
    ]);
  });

  it("cuts the run where the agent did something else", () => {
    const events: RunEvent[] = [
      delta("main", "Let me look."),
      call("main", "c1", { path: "/etc/hosts" }),
      result("main", "c1", "127.0.0.1"),
      delta("main", "It is loopback."),
    ];

    expect(extractUnits(events)).toEqual([
      { id: "0:text", kind: "answer", text: "Let me look." },
      { id: "3:text", kind: "answer", text: "It is loopback." },
    ]);
  });

  it("keeps two interleaved agents apart, one unit per turn each", () => {
    const events: RunEvent[] = [
      delta("main", "I fan "),
      delta("worker-1", "Checking "),
      delta("main", "out."),
      delta("worker-1", "auth."),
    ];

    // Four turns in the chat, so four units: each delta reopens the turn its
    // predecessor lost. Nothing is spliced across agents, which is what a
    // merged fleet stream would otherwise do to both sentences.
    expect(extractUnits(events)).toEqual([
      { id: "0:text", kind: "answer", text: "I fan " },
      { id: "1:text", kind: "answer", text: "Checking " },
      { id: "2:text", kind: "answer", text: "out." },
      { id: "3:text", kind: "answer", text: "auth." },
    ]);
  });

  it("does not let one agent's thinking swallow another's answer", () => {
    const events: RunEvent[] = [delta("main", "one"), think("main", "hm"), delta("main", "two")];

    expect(extractUnits(events, { thinking: true })).toEqual([
      { id: "0:text", kind: "answer", text: "one" },
      { id: "1:text", kind: "thinking", text: "hm" },
      { id: "2:text", kind: "answer", text: "two" },
    ]);
  });

  it("ends a run where the reducer ends the turn: another agent spoke in between", () => {
    // reducer.ts:504 extends the last turn only while it is still this agent's,
    // so sub-a's delta puts the two main runs in two different turns.
    const events: RunEvent[] = [
      think("main", "I need a reviewer."),
      delta("sub-a", "The auth module looks fine."),
      think("main", "Good, I can answer."),
    ];

    expect(extractUnits(events, { thinking: true })).toEqual([
      { id: "0:text", kind: "thinking", text: "I need a reviewer." },
      { id: "1:text", kind: "answer", text: "The auth module looks fine." },
      { id: "2:text", kind: "thinking", text: "Good, I can answer." },
    ]);
  });

  it("ends every open run at run_end", () => {
    const events: RunEvent[] = [
      delta("main", "a"),
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts },
      delta("main", "b"),
    ];

    expect(extractUnits(events).map((u) => u.id)).toEqual(["0:text", "2:text"]);
  });
});

describe("extractUnits — the reasoning stream is opt-in", () => {
  it("leaves thinking out by default", () => {
    const events: RunEvent[] = [think("main", "a long private deliberation"), delta("main", "answer")];

    expect(extractUnits(events)).toEqual([{ id: "1:text", kind: "answer", text: "answer" }]);
  });

  it("carries it when the caller asks for it", () => {
    const events: RunEvent[] = [think("main", "a long private deliberation"), delta("main", "answer")];

    expect(extractUnits(events, { thinking: true })).toEqual([
      { id: "0:text", kind: "thinking", text: "a long private deliberation" },
      { id: "1:text", kind: "answer", text: "answer" },
    ]);
  });
});

describe("applyUnits — total, and it never invents text", () => {
  const events: RunEvent[] = [
    start("чому небо блакитне?"),
    call("main", "c1", { cmd: "ls" }),
    result("main", "c1", "total 4"),
    delta("main", "Because "),
    delta("main", "it scatters."),
    { type: "run_end", runId: "r1", stopReason: "end_turn", ts },
  ];

  it("round-trips through an empty translation", () => {
    const out = applyUnits(events, new Map());

    expect(out).toEqual(events);
    out.forEach((e, i) => expect(e).toBe(events[i]));
  });

  it("keeps length and order whatever it is handed", () => {
    const out = applyUnits(events, new Map([["3:text", "Weil es streut."]]));

    expect(out).toHaveLength(events.length);
    expect(out.map((e) => e.type)).toEqual(events.map((e) => e.type));
  });

  it("ignores an id that addresses nothing", () => {
    const out = applyUnits(
      events,
      new Map([
        ["2:output", "insgesamt 4"],
        ["1:input", "auflisten"],
        ["99:text", "nowhere"],
        ["3:prompt", "wrong field"],
      ]),
    );

    expect(out).toEqual(events);
  });

  it("leaves every untouched event as the SAME object", () => {
    const out = applyUnits(events, new Map([["0:prompt", "warum ist der Himmel blau?"]]));

    expect(out[0]).not.toBe(events[0]);
    [1, 2, 3, 4, 5].forEach((i) => expect(out[i]).toBe(events[i]));
  });

  it("replaces a prompt and touches no other field of that event", () => {
    const out = applyUnits(events, new Map([["0:prompt", "warum ist der Himmel blau?"]]));

    expect(out[0]).toEqual({ ...events[0], prompt: "warum ist der Himmel blau?" });
  });

  it("refuses a blank translation rather than erasing the record", () => {
    const out = applyUnits(
      events,
      new Map([
        ["0:prompt", ""],
        ["3:text", "   \n "],
      ]),
    );

    expect(out).toEqual(events);
  });
});

describe("applyUnits — putting a stream back together", () => {
  it("puts the whole answer into the first delta and blanks the rest", () => {
    const events: RunEvent[] = [
      delta("main", "Because "),
      delta("main", "short "),
      delta("main", "wavelengths scatter."),
    ];
    const out = applyUnits(events, new Map([["0:text", "Weil kurze Wellenlängen streuen."]]));

    expect(out.map((e) => (e as { text: string }).text)).toEqual([
      "Weil kurze Wellenlängen streuen.",
      "",
      "",
    ]);
  });

  it("leaves the concatenation of the run equal to the translation", () => {
    const events: RunEvent[] = [delta("main", "a"), delta("main", "b"), delta("main", "c")];
    const joined = applyUnits(events, new Map([["0:text", "abc translated"]]))
      .map((e) => (e as { text: string }).text)
      .join("");

    expect(joined).toBe("abc translated");
  });

  it("blanks only the run it was given, not the next one", () => {
    const events: RunEvent[] = [
      delta("main", "one "),
      delta("main", "two"),
      call("main", "c1", {}),
      delta("main", "three"),
    ];
    const out = applyUnits(events, new Map([["0:text", "eins zwei"]]));

    expect(out.map((e) => (e as { text?: string }).text)).toEqual(["eins zwei", "", undefined, "three"]);
    expect(out[3]).toBe(events[3]);
  });

  it("translates one agent's stream without disturbing the other's", () => {
    const events: RunEvent[] = [
      delta("main", "I fan "),
      delta("worker-1", "Checking "),
      delta("main", "out."),
      delta("worker-1", "auth."),
    ];
    const out = applyUnits(events, new Map([["0:text", "Ich fächere auf."]]));

    // Index 2 is a turn of its own and keeps its text: blanking it would put
    // main's whole answer in the first turn and leave the second one empty.
    expect(out.map((e) => (e as { text: string }).text)).toEqual([
      "Ich fächere auf.",
      "Checking ",
      "out.",
      "auth.",
    ]);
    [1, 2, 3].forEach((i) => expect(out[i]).toBe(events[i]));
  });

  it("leaves an interrupted agent's later reasoning in its own turn", () => {
    const events: RunEvent[] = [
      think("main", "I need a reviewer."),
      delta("sub-a", "The auth module looks fine."),
      think("main", "Good, I can answer."),
    ];
    const out = applyUnits(events, new Map([["0:text", "Ich brauche einen Reviewer."]]));

    expect(out.map((e) => (e as { text: string }).text)).toEqual([
      "Ich brauche einen Reviewer.",
      "The auth module looks fine.",
      "Good, I can answer.",
    ]);
  });

  it("keeps the event's identity when the translation says the same thing", () => {
    const events: RunEvent[] = [delta("main", "already german")];
    const out = applyUnits(events, new Map([["0:text", "already german"]]));

    expect(out[0]).toBe(events[0]);
  });

  it("applies a reasoning run even though extract left it out by default", () => {
    const events: RunEvent[] = [think("main", "deliberating"), delta("main", "answer")];
    const out = applyUnits(events, new Map([["0:text", "überlege"]]));

    expect((out[0] as { text: string }).text).toBe("überlege");
  });

  it("translates an agent message where extract found one", () => {
    const events: RunEvent[] = [
      {
        type: "agent_message",
        from: "main",
        to: "worker-1",
        role: "task",
        state: "submitted",
        text: "Review the auth module.",
        ts,
      },
    ];
    const out = applyUnits(events, new Map([["0:text", "Prüfe das Auth-Modul."]]));

    expect(out[0]).toEqual({ ...events[0], text: "Prüfe das Auth-Modul." });
  });
});

describe("the two halves agree", () => {
  const events: RunEvent[] = [
    start("чому небо блакитне?"),
    think("main", "physics question"),
    delta("main", "Because "),
    delta("main", "it scatters."),
    call("main", "c1", { cmd: "ls" }),
    result("main", "c1", "total 4"),
    delta("main", "Done."),
    {
      type: "agent_message",
      from: "main",
      to: "worker-1",
      role: "task",
      state: "submitted",
      text: "Check it.",
      ts,
    },
  ];

  it("addresses every extracted unit when the translation comes back", () => {
    const units = extractUnits(events, { thinking: true });
    const translations = new Map(units.map((u) => [u.id, `[${u.kind}] ${u.text}`]));
    const out = applyUnits(events, translations);

    expect(extractUnits(out, { thinking: true }).map((u) => u.text)).toEqual(
      units.map((u) => `[${u.kind}] ${u.text}`),
    );
  });

  it("keeps an id valid after the stream has grown at the end", () => {
    const grown = [...events, delta("main", "More.")];
    const out = applyUnits(grown, new Map([["0:prompt", "warum ist der Himmel blau?"]]));

    expect((out[0] as { prompt: string }).prompt).toBe("warum ist der Himmel blau?");
    expect(out).toHaveLength(grown.length);
  });

  it("does not churn a scalar field whose translation says the same thing", () => {
    const scalars: RunEvent[] = [
      start("unchanged"),
      {
        type: "agent_message",
        from: "main",
        to: "worker-1",
        role: "task",
        state: "submitted",
        text: "also unchanged",
        ts,
      },
      delta("main", "one fragment"),
    ];
    const same = new Map(extractUnits(scalars).map((u) => [u.id, u.text]));
    const out = applyUnits(scalars, same);

    out.forEach((e, i) => expect(e).toBe(scalars[i]));
  });

  it("still collapses a multi-fragment run when the translation is identical — and loses nothing", () => {
    const fragments: RunEvent[] = [delta("main", "Because "), delta("main", "it scatters.")];
    const same = new Map(extractUnits(fragments).map((u) => [u.id, u.text]));
    const out = applyUnits(fragments, same);

    // Collapsing the fragments IS the change; the text the views read is equal.
    expect(out.map((e) => (e as { text: string }).text)).toEqual(["Because it scatters.", ""]);
    expect(out.map((e) => (e as { text: string }).text).join("")).toBe(
      fragments.map((e) => (e as { text: string }).text).join(""),
    );
  });
});
