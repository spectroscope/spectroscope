// Card 519: the exchange pane's expand strip ("expand all" and "default") gets
// its first tests, and the insight and wire faces are pinned as the chat now
// reaches them.
//
// No DOM here: the markup comes from React's server renderer, and a press is
// the handler the component built, run through testkit/driveComponent. The
// pane, its strip and the request parts are run as functions so their props
// can be read pass by pass; Fold and JsonTree stay elements, and what they are
// born with is read off their props.
//
// "Default" has to restore the pane as it OPENED, folds opened by hand
// included. A fold opened by hand keeps its state inside the Fold, and the only
// way back is a remount: React drops a component's state when its key changes.
// So the pin for that half is the section key. Pressing default must move it,
// also when "expand all" was never pressed, which is exactly the case of a
// reader who opened one fold by hand and wants the pane back.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import { drive, type El, type Step } from "../testkit/driveComponent";
import type { LlmExchangeDetail as Bodies, LlmExchangeSide } from "../wire/llmWire";
import { readExchange } from "../wire/llmWire";
import { ALL_LEVELS, JsonTree } from "./JsonTree";
import { ExchangeBodiesPane, ExpandStrip, Fold, RequestParts } from "./LlmExchangeDetail";

const frame = {
  type: "llm_exchange",
  xid: "5d1c2b6e-1f0a-4c55-9a77-0d2c9e1b7a10",
  agentId: "main",
  turn: 1,
  kind: "chat",
  provider: "anthropic",
  model: "claude-sonnet-5",
  transport: "https",
  url: "https://api.anthropic.com/v1/messages",
  status: 200,
  requestBytes: 400,
  responseBytes: 120,
  responseLines: 3,
  aborted: false,
  fidelity: "bytes",
  durationMs: 650,
  ts: 950,
};
const meta = readExchange(frame)!;

const side = (over: Partial<LlmExchangeSide>): LlmExchangeSide => ({
  fidelity: "",
  headers: {},
  transport: "https",
  bodyBytes: 0,
  body: null,
  lines: [],
  omitted: "",
  method: "",
  url: "",
  status: 0,
  error: "",
  aborted: false,
  ...over,
});

/** Five messages, so the messages fold is born closed (it opens unasked only
 *  up to three), a system prompt and two tools, both born closed. */
const requestBody = JSON.stringify({
  model: "claude-sonnet-5",
  max_tokens: 1024,
  system: "You answer briefly.",
  messages: [
    { role: "user", content: "one" },
    { role: "assistant", content: "two" },
    { role: "user", content: "three" },
    { role: "assistant", content: "four" },
    { role: "user", content: "five" },
  ],
  tools: [
    { name: "read_file", description: "Reads a file", input_schema: { type: "object" } },
    { name: "list_dir", description: "Lists a folder", input_schema: { type: "object" } },
  ],
});

const bodies: Bodies = {
  request: side({
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    headers: { "content-type": "application/json" },
    body: requestBody,
    bodyBytes: requestBody.length,
  }),
  response: side({
    status: 200,
    lines: [
      'data: {"type":"message_start","message":{"id":"m1"}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
      "data: [DONE]",
    ],
  }),
};

const EXPAND = [ExchangeBodiesPane, ExpandStrip, RequestParts];

const pane = (face: "structured" | "insight" | "wire") => (
  <ExchangeBodiesPane meta={meta} bodies={bodies} face={face} half="both" />
);

/** The strip's two buttons, by their words. */
function press(label: string): Step {
  return (tree) => {
    const button = tree.find((el) => el.type === "button" && el.props.children === label);
    if (button === undefined) throw new Error(`no button "${label}" in this pass`);
    button.props.onClick?.();
  };
}
const expandAll = press(t("en", "trace.llm.expandAll"));
const backToDefault = press(t("en", "trace.llm.expandDefault"));
const nothing: Step = () => {};

const folds = (tree: El[]): El[] => tree.filter((el) => el.type === Fold);
const trees = (tree: El[]): El[] => tree.filter((el) => el.type === JsonTree);
/** The keys of the sections the epoch remounts. */
const sectionKeys = (tree: El[]): string[] =>
  tree
    .filter((el) => el.type === "div" && el.props.className === "ed-sec" && el.key !== null)
    .map((el) => String(el.key));
const pressedOf = (tree: El[], label: string): unknown =>
  tree.find((el) => el.type === "button" && el.props.children === label)?.props["aria-pressed"];

describe("the expand strip opens everything and goes back (card 519, criterion 5)", () => {
  it("expand all opens every fold on the structured face", () => {
    const before = drive(pane("structured"), EXPAND, []);
    // Positive control: the pane is born with folds, and some of them closed.
    expect(folds(before).length).toBeGreaterThanOrEqual(4);
    expect(folds(before).some((f) => f.props.open === false)).toBe(true);
    const after = drive(pane("structured"), EXPAND, [expandAll]);
    expect(folds(after).length).toBe(folds(before).length);
    expect(folds(after).every((f) => f.props.open === true)).toBe(true);
    expect(pressedOf(after, t("en", "trace.llm.expandAll"))).toBe(true);
  });

  it("expand all sets every tree on the insight face to all levels", () => {
    const before = drive(pane("insight"), EXPAND, []);
    expect(trees(before).length).toBe(2);
    expect(trees(before).every((tr) => tr.props.defaultDepth !== ALL_LEVELS)).toBe(true);
    const after = drive(pane("insight"), EXPAND, [expandAll]);
    expect(trees(after).length).toBe(2);
    expect(trees(after).every((tr) => tr.props.defaultDepth === ALL_LEVELS)).toBe(true);
  });

  it("default restores the folds and the trees as the pane opened", () => {
    const born = drive(pane("structured"), EXPAND, []);
    const back = drive(pane("structured"), EXPAND, [expandAll, backToDefault]);
    expect(folds(back).map((f) => f.props.open)).toEqual(folds(born).map((f) => f.props.open));
    expect(pressedOf(back, t("en", "trace.llm.expandDefault"))).toBe(true);
    const bornTree = drive(pane("insight"), EXPAND, []);
    const backTree = drive(pane("insight"), EXPAND, [expandAll, backToDefault]);
    expect(trees(backTree).map((tr) => tr.props.defaultDepth)).toEqual(
      trees(bornTree).map((tr) => tr.props.defaultDepth),
    );
  });

  it("default remounts the sections, also when only a fold was opened by hand", () => {
    // A fold opened by hand leaves the pane's own state untouched: expand all
    // was never pressed. Default must still remount, or the hand-opened fold
    // stays open.
    for (const face of ["structured", "insight"] as const) {
      const opened = drive(pane(face), EXPAND, [nothing]);
      const keys = sectionKeys(opened);
      expect(keys.length).toBeGreaterThan(0);
      const back = drive(pane(face), EXPAND, [nothing, backToDefault]);
      const after = sectionKeys(back);
      expect(after.length).toBe(keys.length);
      for (const key of after) expect(keys).not.toContain(key);
    }
  });
});

describe("the insight and wire faces (card 519, criterion 2)", () => {
  it("insight shows the request and the response as trees at the trace's default depth", () => {
    const tree = drive(pane("insight"), EXPAND, []);
    const shown = trees(tree);
    expect(shown.length).toBe(2);
    // The request body parsed; the streamed response as one node per line.
    expect(shown[0].props.value).toEqual(JSON.parse(requestBody));
    expect(Array.isArray(shown[1].props.value)).toBe(true);
    expect(shown.map((tr) => tr.props.defaultDepth)).toEqual([4, 3]);
    const html = renderToStaticMarkup(pane("insight"));
    expect(html).toContain('class="json-tree"');
    expect(html).toContain(t("en", "trace.llm.expandAll"));
  });

  it("wire shows the bytes without the expand strip", () => {
    const html = renderToStaticMarkup(pane("wire"));
    expect(html).toContain("POST https://api.anthropic.com/v1/messages");
    expect(html).toContain("content-type: application/json");
    expect(html).toContain("message_start");
    expect(html).not.toContain(t("en", "trace.llm.expandAria"));
    expect(html).not.toContain(t("en", "trace.llm.expandAll"));
    expect(html).not.toContain('class="json-tree"');
  });
});
