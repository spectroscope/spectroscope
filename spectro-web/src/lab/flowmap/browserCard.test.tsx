// CARD 330 — the browser card shows the page it RECORDED. RED FIRST.
//
// The owner asked for "the requested web page (when html is available)".
// THERE IS NO HTML ON THE WIRE and that is deliberate: events.ts:151-152 says
// of browser_action "Metadata only. No bytes ride here, ever: a screenshot is a
// blob in the store and a hash on this line." So nothing below asks for HTML.
// Two better sources exist and both are already reachable:
//   the SCREENSHOT — browser_action.sha256, the same key image_generated
//     carries, fetched by BASENAME through /api/images/<file>
//   the READING   — the sidecar's `result`, served by
//     GET /api/sessions/{id}/browser-wire/action/{cid}
//
// What is pinned here, and the contract the markup hooks make explicit:
//   the node id            "os-browser", an OS-band station, type "os",
//                          kind "browser" — the owner's "counterpart in the OS,
//                          namely the headless browser / demo browser"
//   data-url-state         "address" | "redacted" | "absent"
//                          Measured: `url` is ABSENT on 3 of the 4 real
//                          browser_action events. Absent, redacted and empty
//                          are three states of ONE field and may not collapse.
//   data-page-state        "shot" | "shot-missing" | "reading" | "nothing"
//                          Measured: all 18 image references in the store are
//                          `images/deadbeef.png` written by the Java test suite
//                          and the blob is not on disk — "recorded a picture,
//                          blob is gone" is 100 % of the corpus, not a corner.
//
// FIXTURE PROVENANCE, stated because criterion 11 demands it: the fixtures are
// BUILT, not sampled. The real corpus is four sidecars carrying 6 browser_call,
// 6 browser_result and 5 browser_open; no real recording on this machine
// exercises the screenshot path at all. The refusal string below IS verbatim
// from the store (20260819-160135-b651423f.browser.jsonl) because it is the
// product's own message and the only localhost evidence that exists.
//
// Today OsNode's kinds are disk | shell | net | mcp (nodes.tsx:547) and no
// browser node is emitted anywhere, so the render cases share one failure until
// the branch exists. They diverge the moment it does; each still asks its own
// question and each has to be re-bitten on its own after the build.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { RunEvent } from "../../events";
import { advanceScene, initialScene } from "../labScene";
import { deriveDetail, EXPANDED_CARD, sceneToFlow } from "./sceneToFlow";
import { hasScreenshot, readBrowserAction, screenshotUrl } from "../../wire/browserWire";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { OsNode } from "./nodes";

const Os = OsNode as unknown as (p: { data: unknown }) => ReactElement;

const T = 1787148162959;
const NODE_ID = "os-browser";

/** The measured browser_action shape. `url` is absent on 3 of the 4 real ones. */
const browserAction = (
  over: { url?: string; sha256?: string; ok?: boolean; tool?: string },
  ts = T,
): RunEvent =>
  ({
    type: "browser_action",
    agentId: "main",
    callId: "toolu_013Sdr8vpiqu5sWsu1SwwucK",
    cid: "cc2f8e8e-92a1-4595-a39f-670f2e0a71b3",
    epoch: 1,
    tool: over.tool ?? "browser_navigate",
    ...(over.url === undefined ? {} : { url: over.url }),
    ok: over.ok ?? false,
    resultBytes: 237,
    durationMs: 28,
    ...(over.sha256 === undefined ? {} : { sha256: over.sha256 }),
    ts,
  }) as RunEvent;

const runStart = (): RunEvent =>
  ({
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "open the page",
    provider: "anthropic",
    ts: T - 1,
  }) as RunEvent;

/** Verbatim from the store — the only localhost evidence that exists, and the
 *  honest answer to the owner's "that also goes for local tests of prototypes". */
const REFUSAL =
  "ERROR: browser_navigate refused localhost:8080: it is this machine, and the local " +
  "verify loop is not opted in (set allowLocalhost in the settings to reach it on " +
  "purpose) (rule: loopback). The address it was given: http://localhost:8080/.";

/** What browser_read_page records instead of a picture: the accessibility tree. */
const READING = 'document\n  banner\n    link "Home" [ref_1]\n  main\n    heading "Prototype"';

function flowOf(events: RunEvent[]) {
  const scene = events.reduce(advanceScene, initialScene());
  return sceneToFlow(scene, deriveDetail(events), { provider: "anthropic", model: "claude-opus-5" });
}

const nodeData = (events: RunEvent[]): Record<string, unknown> | undefined =>
  flowOf(events).nodes.find((n) => n.id === NODE_ID)?.data as Record<string, unknown> | undefined;

/** Renders the browser station from hand-built data — the states below are the
 *  component's contract, and several of them (a broken blob, a fetched reading)
 *  are inputs the map cannot know and the component latches. */
const card = (page: unknown): string =>
  renderToStaticMarkup(<Os data={{ kind: "browser", active: true, page }} />);

const urlState = (m: string): string | null => /data-url-state="([^"]*)"/.exec(m)?.[1] ?? null;
const pageState = (m: string): string | null => /data-page-state="([^"]*)"/.exec(m)?.[1] ?? null;
const loadedUrls = (m: string): string[] => [...m.matchAll(/(?:src|href)="([^"]*)"/g)].map((x) => x[1]);

// ---------------------------------------------------------------------------
// 1. There is a browser node at all.
// ---------------------------------------------------------------------------
describe("the map has a browser station (card 330, criterion 1)", () => {
  it("a run that drove a browser puts a browser node on the map", () => {
    expect(
      flowOf([runStart(), browserAction({ url: "https://www.test.de/", ok: true })]).nodes.map((n) => n.id),
    ).toContain(NODE_ID);
  });

  it("the browser station has an envelope of its own, and ext is untouched", () => {
    // A NEW key for a NEW node id collides with nothing. Card 328 takes
    // `mcpserver`, card 329 takes `netz`, this one takes its own.
    expect(EXPANDED_CARD[NODE_ID]).toBeDefined();
    expect(EXPANDED_CARD["ext"]).toEqual({ w: 150, h: 110 });
  });
});

// ---------------------------------------------------------------------------
// 2. The fold learns browser_action — on its own.
// ---------------------------------------------------------------------------
describe("the fold learns browser_action (card 330, criterion 2)", () => {
  it("the recorded address reaches the node", () => {
    const page = nodeData([runStart(), browserAction({ url: "https://www.test.de/", ok: true })])?.page;
    expect((page as { url?: string } | undefined)?.url).toBe("https://www.test.de/");
  });

  it("the recorded screenshot hash reaches the node", () => {
    const page = nodeData([
      runStart(),
      browserAction({ url: "https://www.test.de/", ok: true, sha256: "deadbeef" }),
    ])?.page;
    expect((page as { sha256?: string } | undefined)?.sha256).toBe("deadbeef");
  });

  it("a run that drove no browser leaves the station empty", () => {
    // The other direction — and it demands the NODE first. Without that line
    // this passes vacuously today (no node, so no page), which is green in both
    // directions and pins nothing.
    const data = nodeData([runStart()]);
    expect(data).toBeDefined();
    expect(data?.page ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ADDED DURING THE BUILD, and it is the half the shipped file could not see.
//
// Every render case above hands the card a page object BY HAND, so all of them
// stayed green whatever the fold did — the component's contract was pinned and
// its producer was not. Both joins that fill that object come off the SESSION
// wire and neither had a case:
//
//   the READING — measured on all four real browser calls on this machine, the
//     `tool_result` for the same callId carries the tool's whole answer. That
//     is where "no screenshot -> the recorded reading" and "a refused localhost
//     call renders the refusal AND its rule" actually come from.
//   the SHOT — `browser_action` carries a HASH and no path, and the store is
//     content-addressed. The `image_generated` the same screenshot emitted
//     carries the path for that hash, so the join produces a recorded path
//     instead of a guess about the file extension.
// ---------------------------------------------------------------------------
describe("the fold fills the page from the session wire (card 330)", () => {
  const CALL = "toolu_013Sdr8vpiqu5sWsu1SwwucK";
  const call = (name: string, url: string): RunEvent =>
    ({ type: "tool_call", agentId: "main", callId: CALL, name, input: { url }, ts: T - 1 }) as RunEvent;
  const result = (output: string, isError: boolean): RunEvent =>
    ({
      type: "tool_result",
      agentId: "main",
      callId: CALL,
      output,
      isError,
      durationMs: 28,
      ts: T + 1,
    }) as RunEvent;

  it("a refused localhost call carries its refusal, and its rule, to the node", () => {
    // Verbatim from the store: 3 of the 4 real sidecars are localhost attempts
    // and NONE succeeded. `allowLocalhost` is off by default and the fence
    // names itself in the answer.
    const page = nodeData([
      runStart(),
      call("browser_navigate", "http://localhost:8080/"),
      browserAction({ ok: false }),
      result(REFUSAL, true),
    ])?.page as { reading?: string } | undefined;
    expect(page?.reading).toContain("refused localhost:8080");
    expect(page?.reading).toContain("rule: loopback");
  });

  it("some OTHER tool's answer does not become the page's reading", () => {
    // Without this the join is only a "first tool_result after the browser
    // action wins" — measured green with the callId guard deleted, which is a
    // guard that cannot fire. A run does not stop at its browser call: the next
    // tool_result is an ordinary one and would have been printed as the page.
    const page = nodeData([
      runStart(),
      call("browser_navigate", "https://www.test.de/"),
      browserAction({ url: "https://www.test.de/", ok: true }),
      {
        type: "tool_result",
        agentId: "main",
        callId: "toolu_someOtherCallEntirely",
        output: "THE SHELL'S ANSWER, WHICH IS NOT A PAGE",
        isError: false,
        durationMs: 4,
        ts: T + 2,
      } as RunEvent,
    ])?.page as { reading?: string | null } | undefined;
    expect(page?.reading ?? null).toBeNull();
  });

  it("a CHILD starting does not throw the recorded page away", () => {
    // 25 of 25 child run_starts on this machine carry their own runId.
    const page = nodeData([
      runStart(),
      browserAction({ url: "https://www.test.de/", ok: true }),
      {
        type: "run_start",
        runId: "worker-1-run",
        agentId: "worker-1",
        prompt: "look",
        provider: "anthropic",
        ts: T + 500,
      } as RunEvent,
    ])?.page as { url?: string } | undefined;
    expect(page?.url).toBe("https://www.test.de/");
  });

  it("a recorded hash finds the path the image_generated announced for it", () => {
    const page = nodeData([
      runStart(),
      {
        type: "image_generated",
        agentId: "main",
        callId: CALL,
        prompt: "browser_computer screenshot of https://www.test.de/",
        provider: "browser",
        model: "webcontentsview",
        mediaType: "image/png",
        blobPath: "images/9f2c1a.png",
        sha256: "9f2c1a",
        ts: T - 1,
      } as RunEvent,
      browserAction({ url: "https://www.test.de/", ok: true, sha256: "9f2c1a" }),
    ])?.page as { shot?: { blobPath: string } | null } | undefined;
    expect(page?.shot?.blobPath).toBe("images/9f2c1a.png");
  });

  it("a hash the run never stored a path for is not turned into one", () => {
    // The other direction, and it is the honest state: the card has a hash and
    // no address for it, which is "a picture was recorded and this card cannot
    // load it" — not "no picture was taken". Guessing `images/<sha>.png` would
    // be the card inventing a file name.
    const page = nodeData([
      runStart(),
      browserAction({ url: "https://www.test.de/", ok: true, sha256: "deadbeef" }),
    ])?.page as { shot?: unknown; sha256?: string } | undefined;
    expect(page?.sha256).toBe("deadbeef");
    expect(page?.shot ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The card never fetches anything the recording did not record.
//    This is the criterion that keeps a replay from becoming a browser.
// ---------------------------------------------------------------------------
describe("nothing is fetched from the page itself (card 330, criterion 3)", () => {
  it("every URL the rendered card loads is the image endpoint", () => {
    const m = card({
      url: "https://www.test.de/",
      urlState: "address",
      shot: { blobPath: "images/9f2c1a.png", sha256: "9f2c1a" },
    });
    expect(loadedUrls(m).length).toBeGreaterThan(0);
    for (const u of loadedUrls(m)) expect(u.startsWith("/api/images/")).toBe(true);
  });

  it("the recorded address never becomes a request", () => {
    const m = card({ url: "https://www.test.de/", urlState: "address", shot: null, reading: null });
    expect(m).not.toContain('src="https://www.test.de/');
    expect(m).not.toContain('href="https://www.test.de/');
  });
});

// ---------------------------------------------------------------------------
// 4. Absent, redacted and empty are three states of ONE field.
// ---------------------------------------------------------------------------
describe("the recorded address (card 330, criterion 4)", () => {
  it("an address that was recorded is shown", () => {
    const m = card({ url: "https://www.test.de/", shot: null, reading: null });
    expect(urlState(m)).toBe("address");
    expect(m).toContain("www.test.de");
  });

  it("an address that was redacted reads as redacted, and no host is shown for it", () => {
    // BrowserWireRecorder.java:427 — the bracketed address form. Zero markers
    // exist anywhere in the store, so the shape comes from the writer.
    const m = card({ url: "[redacted: bearer-token]", shot: null, reading: null });
    expect(urlState(m)).toBe("redacted");
    expect(m).not.toContain("data-host=");
  });

  it("the object marker form is not printed as an address either", () => {
    // BrowserWireRecorder.java:376 — the input form, {kind,rule,bytes}. Bitten
    // separately from the bracketed form: one shape may be handled and the
    // other missed, and "[object Object]" on a card is the failure that looks
    // like a rendering bug rather than a redaction bug.
    const m = card({ url: { kind: "redacted", rule: "bearer-token", bytes: 64 }, shot: null, reading: null });
    expect(urlState(m)).toBe("redacted");
    expect(m).not.toContain("object Object");
  });

  it("a call that opened no page says the address is absent, not empty", () => {
    // Measured: 3 of the 4 real browser_action events carry NO url — a failed
    // navigate records no page. "Absent" and "empty" are different facts.
    const m = card({ url: undefined, shot: null, reading: null });
    expect(urlState(m)).toBe("absent");
  });
});

// ---------------------------------------------------------------------------
// 5/6. Picture, missing blob, reading, neither — four readings, four bites.
// ---------------------------------------------------------------------------
describe("what the card can show of the page (card 330, criteria 5 and 6)", () => {
  const withShot = { url: "https://www.test.de/", shot: { blobPath: "images/9f2c1a.png", sha256: "9f2c1a" } };

  it("a call with a screenshot shows it", () => {
    const m = card({ ...withShot, reading: null });
    expect(pageState(m)).toBe("shot");
    expect(m).toContain("<img");
    expect(loadedUrls(m)).toContain("/api/images/9f2c1a.png");
  });

  it("a hash whose blob is gone does not render a broken image", () => {
    // 100 % of the corpus: all 18 image references are `images/deadbeef.png`
    // with sha `deadbeef`, written by the Java test suite, and the blob is not
    // on disk. The same path is already live on a shipped surface — of 6
    // image_generated events, 5 blobs exist and 1 does not. `shotBroken` is the
    // latch the component owns; the map cannot know.
    const m = card({
      url: "https://www.test.de/",
      shot: { blobPath: "images/deadbeef.png", sha256: "deadbeef" },
      shotBroken: true,
      reading: null,
    });
    expect(pageState(m)).toBe("shot-missing");
    expect(m).not.toContain("<img");
  });

  it("a call read rather than photographed shows the recorded reading", () => {
    const m = card({
      url: "http://localhost:8080/",
      shot: null,
      reading: READING,
      tool: "browser_read_page",
    });
    expect(pageState(m)).toBe("reading");
    expect(m).toContain("heading &quot;Prototype&quot;");
    expect(m).not.toContain("<img");
  });

  it("a call with neither a picture nor a reading says so", () => {
    const m = card({ url: "https://www.test.de/", shot: null, reading: null });
    expect(pageState(m)).toBe("nothing");
  });

  it("a missing blob and a call that took no picture do not read alike", () => {
    // Two different facts. Collapsing them would tell a reader that no picture
    // was taken when one was, and its blob was swept.
    const gone = card({
      url: "https://www.test.de/",
      shot: { blobPath: "images/deadbeef.png", sha256: "deadbeef" },
      shotBroken: true,
      reading: null,
    });
    const never = card({ url: "https://www.test.de/", shot: null, reading: null });
    expect(pageState(gone)).not.toBe(pageState(never));
  });
});

// ---------------------------------------------------------------------------
// 7. A refused localhost call renders the refusal AND its rule.
// ---------------------------------------------------------------------------
describe("a refused local prototype (card 330, criterion 7)", () => {
  const m = () => card({ url: "http://localhost:8080/", ok: false, shot: null, reading: REFUSAL });

  it("shows the refusal and names the rule that fired", () => {
    // Measured: 3 of the 4 real sidecars are localhost attempts and NONE
    // succeeded. `allowLocalhost` is off by default and the fence names itself.
    expect(m()).toContain("refused localhost:8080");
    expect(m()).toContain("rule: loopback");
  });

  it("does not read as a call that recorded nothing", () => {
    expect(pageState(m())).not.toBe("nothing");
  });

  it("draws no page for it", () => {
    expect(m()).not.toContain("<img");
  });
});

// ---------------------------------------------------------------------------
// 8. The sidecar is read through the ENDPOINT, and the shape trap is closed.
//
// The raw file nests the picture as browser_result.image.{...}; the index
// endpoint FLATTENS it to top level (openEntry, BrowserWireController.java:232,
// keys :244-251), which is what readBrowserAction expects. Fed the nested
// shape, today's reader returns a perfectly valid step that claims no
// screenshot — silently.
// ---------------------------------------------------------------------------
describe("the reader does not silently lose a screenshot (card 330, criterion 8)", () => {
  it("the nested sidecar shape does not produce a screenshot-less step", () => {
    const nested = {
      type: "browser_result",
      cid: "cc2f8e8e-92a1-4595-a39f-670f2e0a71b3",
      epoch: 1,
      ok: true,
      resultBytes: 128,
      durationMs: 1126,
      ts: T,
      image: {
        mediaType: "image/png",
        blobPath: "images/deadbeef.png",
        sha256: "deadbeef",
        width: 1200,
        height: 800,
        bytes: 4096,
      },
    };
    const step = readBrowserAction(nested);
    // Either it reads the nested shape, or it refuses the row. What it may not
    // do is hand back a step that says "no picture was taken".
    expect(step === null || hasScreenshot(step)).toBe(true);
  });

  // GREEN TODAY, and genuinely so: this is the shipped reader's real behaviour.
  // It is the other-direction guard for the case above — without it, "does not
  // produce a screenshot-less step" could be satisfied by refusing every row.
  it("the flattened endpoint shape still reads as a screenshot", () => {
    const flat = {
      cid: "cc2f8e8e-92a1-4595-a39f-670f2e0a71b3",
      epoch: 1,
      ok: true,
      ts: T,
      blobPath: "images/deadbeef.png",
      sha256: "deadbeef",
      mediaType: "image/png",
      width: 1200,
      height: 800,
    };
    expect(hasScreenshot(readBrowserAction(flat)!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. The screenshot URL comes from the one rule, not a third copy of it.
// ---------------------------------------------------------------------------
describe("the screenshot URL is the basename rule (card 330, criterion 10)", () => {
  // GREEN TODAY, and genuinely so: `screenshotUrl` already enforces this. It is
  // here so the render case below is held to the SAME rule instead of a third
  // copy of it — a third copy is a third place for a path-traversal bug.
  it("a recorded path with ../ addresses only its basename", () => {
    const step = readBrowserAction({
      cid: "c",
      ts: T,
      epoch: 1,
      blobPath: "../../etc/passwd.png",
      sha256: "deadbeef",
    })!;
    expect(screenshotUrl(step)).toBe("/api/images/passwd.png");
  });

  it("the card's rendered image uses that same rule", () => {
    // A third copy of the rule is a third place for a path-traversal bug.
    const m = card({
      url: "https://www.test.de/",
      shot: { blobPath: "../../etc/passwd.png", sha256: "deadbeef" },
    });
    expect(loadedUrls(m)).toContain("/api/images/passwd.png");
  });
});
