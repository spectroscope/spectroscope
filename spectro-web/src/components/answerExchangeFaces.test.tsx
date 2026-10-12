// Card 519: the exchange under an answer offers the faces the trace offers.
//
// The owner: "Ich würde gerne noch ein Insights, also wo wieder so ein JSON da
// ist, was man aufklappen kann." The pane already had the insight and wire
// faces since card 473; the chat opened it on structured and gave no way to
// switch. These tests pin the strip that does: the trace's labels, its group,
// its pressed state, drawn from the faces the pane supports and withdrawn the
// way state/traceFace.ts withdraws them for the trace.
//
// No DOM here: the markup comes from React's server renderer, and a press is
// the handler the component built, run through testkit/driveComponent.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import ccLinear from "../import/fixtures/cc-linear.jsonl?raw";
import { detectAndLoad } from "../import/detect";
import { t } from "../i18n/i18n";
import { initialState, reduceAll } from "../state/reducer";
import { currentTraceFace, setTraceFace, traceOriginOf, type TraceOrigin } from "../state/traceFace";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { readExchange, type LlmExchangeMeta } from "../wire/llmWire";
import { AnswerExchange, ExchangeFacePane } from "./AnswerExchange";
import { Chat } from "./Chat";
import { EXCHANGE_FACES, LlmExchangeDetail, exchangeFacesOf } from "./LlmExchangeDetail";

const meta: LlmExchangeMeta = readExchange({
  type: "llm_exchange",
  xid: "8f4e2a10-3b6c-4d1e-9f02-6a7b8c9d0e1f",
  agentId: "main",
  turn: 1,
  kind: "chat",
  provider: "ollama",
  model: "qwen2.5:7b",
  transport: "http",
  url: "http://localhost:11434/api/chat",
  status: 200,
  requestBytes: 200,
  responseBytes: 90,
  responseLines: 4,
  aborted: false,
  fidelity: "bytes",
  durationMs: 400,
  ts: 20,
})!;

const label = (face: string): string => t("en", `trace.mode.${face}`);

const pane = (origin: TraceOrigin = "native") => (
  <ExchangeFacePane meta={meta} sessionId="20261011-120000-aaaabbbb" origin={origin} />
);

/** The face strip's buttons, in order. */
const faceButtons = (tree: El[]): El[] => {
  const strip = tree.find(
    (el) => el.type === "div" && el.props.className === "trace-detail-modes" && el.props.role === "group",
  );
  if (strip === undefined) return [];
  return tree.filter(
    (el) => el.type === "button" && (strip.props.children as El[]).some((child) => child === el),
  );
};
const press =
  (face: string): Step =>
  (tree) => {
    const button = faceButtons(tree).find((el) => el.props.children === label(face));
    if (button === undefined) throw new Error(`no face "${face}" in this pass`);
    button.props.onClick?.();
  };
const detailOf = (tree: El[]): El => {
  const detail = tree.find((el) => el.type === LlmExchangeDetail);
  if (detail === undefined) throw new Error("no exchange pane in this pass");
  return detail;
};

beforeEach(() => {
  setTraceFace("structured");
});

describe("the strip under an answer (card 519, criterion 1)", () => {
  it("shows Structured, Insight and Wire in the trace's group, Structured pressed", () => {
    const html = renderToStaticMarkup(pane());
    expect(html).toContain(
      `<div class="trace-detail-modes" role="group" aria-label="${t("en", "trace.modeAria")}">` +
        `<button type="button" aria-pressed="true">${label("structured")}</button>` +
        `<button type="button" aria-pressed="false">${label("insight")}</button>` +
        `<button type="button" aria-pressed="false">${label("wire")}</button>` +
        `</div>`,
    );
  });

  it("is drawn from the faces the pane supports", () => {
    expect(EXCHANGE_FACES).toEqual(["structured", "insight", "wire"]);
    expect(exchangeFacesOf("native")).toEqual([...EXCHANGE_FACES]);
    const tree = drive(pane(), [ExchangeFacePane], []);
    expect(faceButtons(tree).map((b) => b.props.children)).toEqual(EXCHANGE_FACES.map(label));
  });

  it("hands the pressed face to the exchange pane", () => {
    const born = drive(pane(), [ExchangeFacePane], []);
    expect(detailOf(born).props.face).toBe("structured");
    const insight = drive(pane(), [ExchangeFacePane], [press("insight")]);
    expect(detailOf(insight).props.face).toBe("insight");
    expect(faceButtons(insight).map((b) => b.props["aria-pressed"])).toEqual([false, true, false]);
    const wire = drive(pane(), [ExchangeFacePane], [press("wire")]);
    expect(detailOf(wire).props.face).toBe("wire");
    expect(faceButtons(wire).map((b) => b.props["aria-pressed"])).toEqual([false, false, true]);
  });
});

describe("a foreign import offers Structured alone (card 519, criterion 3)", () => {
  it("loads a Claude Code transcript and finds one face", () => {
    const { kind, events } = detectAndLoad(ccLinear);
    expect(kind).toBe("claude-code");
    const origin = traceOriginOf(kind, null);
    expect(exchangeFacesOf(origin)).toEqual(["structured"]);

    // The chat hands the session's origin to the answer's opener.
    const chat = drive(
      <Chat
        state={reduceAll(initialState, events)}
        liveView={false}
        onSend={() => {}}
        onReturnToLive={() => {}}
        sendClient={() => false}
        readOnlyNote="Imported sessions are read-only."
        exchangeSessionId="import:claude-code:cc-linear"
        exchangeOrigin={origin}
      />,
      [Chat],
      [],
    );
    const openers = chat.filter((el) => el.type === AnswerExchange);
    expect(openers.length).toBeGreaterThan(0);
    for (const opener of openers) expect(opener.props.origin).toBe("claude-code");

    // And the opened pane offers the one face.
    const tree = drive(pane(origin), [ExchangeFacePane], []);
    const buttons = faceButtons(tree);
    expect(buttons.map((b) => b.props.children)).toEqual([label("structured")]);
    expect(buttons[0].props["aria-pressed"]).toBe(true);
    expect(detailOf(tree).props.face).toBe("structured");
  });

  it("offers all three for our own import, the positive control", () => {
    expect(exchangeFacesOf(traceOriginOf("spectroscope", null))).toEqual(["structured", "insight", "wire"]);
  });
});

describe("the choice is per pane and per open (card 519, criterion 4)", () => {
  it("does not touch the trace's master face", () => {
    setTraceFace("wire");
    const before = currentTraceFace();
    drive(pane(), [ExchangeFacePane], [press("insight")]);
    drive(pane(), [ExchangeFacePane], [press("structured")]);
    expect(currentTraceFace()).toBe(before);
    expect(currentTraceFace().face).toBe("wire");
  });

  it("opens on Structured whatever the trace's master says", () => {
    setTraceFace("insight");
    const tree = drive(pane(), [ExchangeFacePane], []);
    expect(detailOf(tree).props.face).toBe("structured");
  });

  it("starts on Structured again after a close and a reopen", () => {
    // A switch in one open does not carry into the next: the face lives in the
    // pane, and the pane is unmounted when the exchange closes.
    const first = drive(pane(), [ExchangeFacePane], [press("wire")]);
    expect(detailOf(first).props.face).toBe("wire");
    const reopened = drive(pane(), [ExchangeFacePane], []);
    expect(detailOf(reopened).props.face).toBe("structured");
    // The opener renders its body only while open, so closing drops the pane.
    const closed = renderToStaticMarkup(
      <AnswerExchange sessionId="s" agentId="main" endTs={20} origin="native" />,
    );
    expect(closed).not.toContain("answer-exchange-body");
    expect(closed).not.toContain('class="trace-detail-modes"');
  });
});
