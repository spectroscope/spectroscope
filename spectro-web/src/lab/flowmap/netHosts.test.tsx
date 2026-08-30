// CARD 329 — the network says what left the machine. RED FIRST.
//
// What these cases drive:
//
//   · The fold is BLIND to both address-carrying events.
//     `grep -rn "llm_exchange\|browser_action" spectro-web/src/lab/` returns
//     zero matches, tests included. So this is not a render change on data the
//     fold already holds: it needs a new case in `deriveDetail` and a new field
//     on `Detail`. The two events are bitten SEPARATELY below — a case whose
//     only address source is an `llm_exchange`, and a case whose only address
//     source is a `browser_action`.
//
//   · Nothing here names a `Detail` field. Every case goes events ->
//     `sceneToFlow` -> the `netz` node's data -> rendered markup, so the tests
//     pin the reader's experience and leave the fold's internal naming to the
//     build. That is also what makes them survive a rename.
//
//   · Markup hooks demanded, as a contract:
//       data-reached="none"          when the run reached nothing
//       data-host="<host>"           one per host row, DERIVED from the events
//       data-host-state="redacted"   a row whose address was redacted
//       data-hosts-more="<n>"        how many hosts are below the row cap
//
//   · Measured, and every figure below is why a case exists:
//     six distinct hosts in the entire history; 36 of 783 sessions reached
//     anything at all, 34 of those 36 reached exactly ONE host and 2 reached
//     two — never three. 45 of 137 exchanges are loopback. 58 of 137 went to
//     100.90.57.62:1234, a Tailscale/CGNAT address — the largest single group,
//     and neither loopback nor the public internet. ZERO redaction markers
//     exist anywhere in the store, so those fixtures take their shape from the
//     writer (BrowserWireRecorder.java:427 and :376), not from a guess.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { RunEvent } from "../../events";
import { advanceScene, initialScene } from "../labScene";
import { deriveDetail, EXPANDED_CARD, sceneToFlow } from "./sceneToFlow";
import { isLoopbackAddress } from "../../state/runDigest";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { ExtNode } from "./nodes";

const Ext = ExtNode as unknown as (p: { data: unknown }) => ReactElement;

const T = 1786369401796;

const runStart = (): RunEvent =>
  ({
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "go",
    provider: "anthropic",
    ts: T,
  }) as RunEvent;

/** The measured llm_exchange shape, verbatim in its FIELDS. */
const exchange = (url: string, provider = "anthropic", ts = T): RunEvent =>
  ({
    type: "llm_exchange",
    xid: `x-${ts}-${url.length}`,
    agentId: "main",
    turn: 1,
    kind: "chat",
    provider,
    model: "claude-opus-5",
    transport: "sdk",
    url,
    requestBytes: 9089,
    responseBytes: 2292,
    responseLines: 24,
    aborted: false,
    fidelity: "sdk-json",
    durationMs: 5030,
    ts,
  }) as RunEvent;

/** The measured browser_action shape. `url` is ABSENT on 3 of the 4 real ones. */
const browserAction = (url: string | undefined, ts = T): RunEvent =>
  ({
    type: "browser_action",
    agentId: "main",
    callId: "toolu_013Sdr8vpiqu5sWsu1SwwucK",
    cid: `cid-${ts}`,
    epoch: 1,
    tool: "browser_navigate",
    ...(url === undefined ? {} : { url }),
    ok: url !== undefined,
    resultBytes: 128,
    durationMs: 1127,
    ts,
  }) as RunEvent;

function netCard(events: RunEvent[]): string {
  const scene = events.reduce(advanceScene, initialScene());
  const detail = deriveDetail(events);
  const flow = sceneToFlow(scene, detail, { provider: "anthropic", model: "claude-opus-5" });
  const data = flow.nodes.find((n) => n.id === "netz")?.data ?? {};
  return renderToStaticMarkup(<Ext data={data} />);
}

function flowOf(events: RunEvent[]) {
  const scene = events.reduce(advanceScene, initialScene());
  return sceneToFlow(scene, deriveDetail(events), { provider: "anthropic", model: "claude-opus-5" });
}

/** The table is typed Record<string, {w,h}>, so a lookup is total and a missing
 *  key reads as undefined — which keeps the seat cases red on their assertion
 *  rather than on a compile error. */
const EXPANDED_CARD_OF = (id: string): { w: number; h: number } | undefined => EXPANDED_CARD[id];

const hostsIn = (markup: string): string[] => [...markup.matchAll(/data-host="([^"]*)"/g)].map((m) => m[1]);
const moreIn = (markup: string): number => Number(/data-hosts-more="(\d+)"/.exec(markup)?.[1] ?? "0");

// ---------------------------------------------------------------------------
// 1. The fold learns the two events it is blind to — bitten separately.
// ---------------------------------------------------------------------------
describe("the fold learns the address-carrying events (card 329, criterion 1)", () => {
  it("an llm_exchange puts its host on the Net card", () => {
    const m = netCard([runStart(), exchange("https://api.anthropic.com/v1/messages")]);
    expect(hostsIn(m)).toContain("api.anthropic.com");
  });

  it("a browser_action puts its host on the Net card", () => {
    // Its own case: a build that folded only llm_exchange passes the one above
    // and fails this one, which is the point of biting them apart.
    const m = netCard([runStart(), browserAction("https://www.test.de/")]);
    expect(hostsIn(m)).toContain("www.test.de");
  });
});

// ---------------------------------------------------------------------------
// 2. The list is DERIVED, never typed. The card-312 bite.
// ---------------------------------------------------------------------------
describe("the host list is derived from the run (card 329, criterion 2)", () => {
  it("a host this test never spells appears anyway, and the row count follows the events", () => {
    // The fourth host's name exists nowhere in this file as a literal — it is
    // built at run time. A hand list with a loop around it renders three rows;
    // a derivation renders four. That difference is the whole criterion.
    const invented = `h${Math.random().toString(36).slice(2, 10)}.example.invalid`;
    const m = netCard([
      runStart(),
      exchange("https://api.anthropic.com/v1/messages"),
      exchange("https://api.openai.com/v1/chat/completions", "openai", T + 1),
      browserAction("https://www.test.de/", T + 2),
      exchange(`https://${invented}/v1/messages`, "custom", T + 3),
    ]);
    expect(hostsIn(m)).toContain(invented);
    expect(hostsIn(m)).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 3. A run that reached nothing says so. The COMMON case — 4.6 % of sessions
//    carry any llm_exchange at all — so it is designed first.
// ---------------------------------------------------------------------------
describe("a run that reached nothing (card 329, criterion 3)", () => {
  const m = () => netCard([runStart()]);

  // GREEN TODAY, on purpose: no card renders host rows yet, so this one passes
  // vacuously. It is here as the guard that the empty state stays empty once
  // the derivation lands; its two red siblings below carry the criterion.
  it("lists no hosts", () => {
    expect(hostsIn(m())).toEqual([]);
  });

  it("says the run reached nothing", () => {
    expect(m()).toContain('data-reached="none"');
  });

  it("does not print Routing · Internet over a run that routed nothing", () => {
    expect(m()).not.toContain("Routing · Internet");
  });
});

// ---------------------------------------------------------------------------
// 4. A local backend is never drawn as outbound.
//    Measured: 45 of 137 exchanges are loopback, in four forms.
// ---------------------------------------------------------------------------
describe("a local backend never leaves the machine (card 329, criterion 4)", () => {
  // Each case carries a REMOTE control in the same fixture. Without it the
  // assertion would be "no hosts at all", which an unimplemented card satisfies
  // by rendering nothing — green in both directions, pinning nothing. With it,
  // the case is red until the derivation exists AND stays red if a loopback
  // address ever leaks into the outbound list.
  it.each([
    ["http://localhost:11434/api/chat", 19],
    ["http://127.0.0.1:62635/api/chat", 13],
    ["http://127.0.0.1:52936/api/chat", 10],
    ["http://localhost:1234/v1/chat/completions", 3],
  ])("%s (%i measured exchanges) is not listed as outbound", (url) => {
    const m = netCard([
      runStart(),
      exchange(url as string, "ollama"),
      exchange("https://api.anthropic.com/v1/messages", "anthropic", T + 1),
    ]);
    expect(hostsIn(m)).toEqual(["api.anthropic.com"]);
  });
});

// ---------------------------------------------------------------------------
// 5. The locality test is the EXISTING one, not a second copy.
// ---------------------------------------------------------------------------
describe("the locality test is runDigest's (card 329, criterion 5)", () => {
  it("localhost.evil.example is not local, and the shipped test already says so", () => {
    // The existing function's own doc names this host as the reason it matches
    // exactly and never by substring. Both halves are asserted so a second,
    // sloppier copy inside the map cannot pass this.
    expect(isLoopbackAddress("localhost.evil.example:443")).toBe(false);
    const m = netCard([runStart(), exchange("https://localhost.evil.example:443/v1/messages")]);
    expect(hostsIn(m)).toContain("localhost.evil.example");
  });
});

// ---------------------------------------------------------------------------
// 6. The machine next door — the largest single group in the whole history.
//
// 58 of 137 exchanges went to 100.90.57.62:1234, a Tailscale/CGNAT address in
// 100.64.0.0/10: LM Studio on the owner's OTHER machine. It DID leave this
// machine, so calling it local is a lie; it is not the public internet, so
// filing it under "Routing · Internet" is also a lie. Which of the two allowed
// shapes ships — a third category, or no categories and just the host — is an
// owner call, so nothing below names a category.
// ---------------------------------------------------------------------------
describe("the tailnet address is neither local nor the internet (card 329, criterion 6)", () => {
  const m = () => netCard([runStart(), exchange("http://100.90.57.62:1234/v1/chat/completions", "lmstudio")]);

  it("is not filtered away as local", () => {
    expect(isLoopbackAddress("100.90.57.62:1234")).toBe(false);
    expect(hostsIn(m())).toContain("100.90.57.62:1234");
  });

  it("is not filed under the public internet", () => {
    expect(m()).not.toContain("Routing · Internet");
  });
});

// ---------------------------------------------------------------------------
// 7. A redacted address renders as redacted, never as a host.
//
// Zero markers exist in the store, so both writer shapes are in the fixture and
// each is bitten on its own:
//   the address form, BrowserWireRecorder.java:427 — "[redacted: " + rule + "]"
//   the input form,   BrowserWireRecorder.java:376 — {kind,rule,bytes}
// ---------------------------------------------------------------------------
describe("a redacted address stays redacted (card 329, criterion 7)", () => {
  it("the bracketed address form renders as a redaction, not as a host", () => {
    // The remote control is in the fixture for the same reason as above: the
    // second assertion must fail on a marker leaking INTO the host list, not
    // pass because the list is empty for want of an implementation.
    const m = netCard([
      runStart(),
      browserAction("[redacted: bearer-token]"),
      exchange("https://api.anthropic.com/v1/messages", "anthropic", T + 1),
    ]);
    expect(m).toContain('data-host-state="redacted"');
    expect(hostsIn(m)).toEqual(["api.anthropic.com"]);
  });

  it("the object marker form is not scraped into a host either", () => {
    // Defensive: the session wire types `url` as a string, but the same idea
    // travels as an object in the sidecar, and a tolerant reader must not turn
    // it into "[object Object]" or dig a host out of it.
    const marker = { kind: "redacted", rule: "bearer-token", bytes: 64 };
    const event = {
      ...(browserAction(undefined) as unknown as Record<string, unknown>),
      url: marker,
    } as unknown as RunEvent;
    const m = netCard([
      runStart(),
      event,
      exchange("https://api.anthropic.com/v1/messages", "anthropic", T + 1),
    ]);
    expect(hostsIn(m)).toEqual(["api.anthropic.com"]);
    expect(m).toContain('data-host-state="redacted"');
    expect(m).not.toContain("object Object");
  });
});

// ---------------------------------------------------------------------------
// 8. The node lights for what crossed the boundary.
//    Today `active: mcpInUse` is the whole condition, so every one of the 137
//    measured exchanges leaves it dark.
// ---------------------------------------------------------------------------
describe("the node lights for what crossed (card 329, criterion 8)", () => {
  const active = (id: string, events: RunEvent[]) =>
    (flowOf(events).nodes.find((n) => n.id === id)?.data as { active?: boolean } | undefined)?.active;

  it("a remote exchange with no MCP call at all lights the boundary nodes", () => {
    const events = [runStart(), exchange("https://api.anthropic.com/v1/messages")];
    expect(active("netz", events)).toBe(true);
    expect(active("os-net", events)).toBe(true);
  });

  // GREEN TODAY: `active: mcpInUse` is already false here. The guard exists so
  // the fix for the red case above cannot simply light the node permanently.
  it("a run that reached nothing leaves them dark", () => {
    expect(active("netz", [runStart()])).toBe(false);
    expect(active("os-net", [runStart()])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. The card is bounded for N hosts.
//    Measured: 34 of the 36 sessions that reached anything reached exactly one
//    host and 2 reached two — never three. A design for twelve rows is a design
//    for data that does not exist, so the cap is the card's to pick; what is
//    pinned here is that nothing is silently dropped.
// ---------------------------------------------------------------------------
describe("the card is bounded and drops nothing silently (card 329, criterion 11)", () => {
  it("twelve hosts render as rows plus a counted remainder", () => {
    const events: RunEvent[] = [runStart()];
    for (let i = 0; i < 12; i++)
      events.push(exchange(`https://host-${i}.example.invalid/v1`, "custom", T + i));
    const m = netCard(events);
    expect(hostsIn(m).length).toBeLessThan(12);
    expect(hostsIn(m).length + moreIn(m)).toBe(12);
  });

  it("two hosts — the measured worst case — render whole, with nothing hidden", () => {
    const m = netCard([
      runStart(),
      exchange("https://api.anthropic.com/v1/messages"),
      exchange("http://100.90.57.62:1234/v1/chat/completions", "lmstudio", T + 1),
    ]);
    expect(hostsIn(m)).toHaveLength(2);
    expect(moreIn(m)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. The seat is its own key; `ext` is not touched.
// ---------------------------------------------------------------------------
describe("the Net seat is its own (card 329, criterion 9/10)", () => {
  it("netz has an envelope of its own", () => {
    expect(EXPANDED_CARD_OF("netz")).toBeDefined();
  });

  // GREEN TODAY: a regression guard, not coverage. It goes red the moment this
  // card or card 328 grows `ext` instead of adding its own key — which would
  // silently resize the OTHER external card and make the merge a collision.
  it("the shared ext envelope is left exactly as it was", () => {
    expect(EXPANDED_CARD_OF("ext")).toEqual({ w: 150, h: 110 });
  });

  it("the Net width stays 150 — widths feed card 319's layout", () => {
    expect(EXPANDED_CARD_OF("netz")?.w).toBe(150);
  });
});
