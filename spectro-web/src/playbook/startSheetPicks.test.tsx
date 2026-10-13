// Card 584: the start sheet names why a step's model does not serve, offers a
// model picker per row with the playbook's model as the default, and keeps
// Start disabled while a row has no model that serves; a pick from a list
// that answered unblocks its row, and Start sends the picks.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import type { Picks } from "../state/playbookPicks";
import type { StartPreview } from "../state/playbookRuns";
import { drive, type El } from "../testkit/driveComponent";
import { PlaybookStartSheet } from "./PlaybookStartSheet";

const PREVIEW: StartPreview = {
  dir: "/pb",
  hash: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  findings: [],
  steps: [
    {
      id: "write_plan",
      name: "Write plan",
      performer: "chat",
      role: null,
      choice: "strong",
      provider: "anthropic",
      model: "claude-opus-5-5",
      providerKind: "cloud",
      providerState: "failed",
      privacy: "cheap",
      permission: "inherit",
      nod: false,
    },
    {
      id: "tidy",
      name: "Tidy",
      performer: "chat",
      role: null,
      choice: "local",
      provider: "ollama",
      model: "qwen3:8b",
      providerKind: "local",
      providerState: "reachable",
      privacy: "private",
      permission: "inherit",
      nod: false,
    },
  ],
  skills: [],
  commands: [],
  refusals: [],
  models: [
    {
      node: "write_plan",
      name: "Write plan",
      kind: "step",
      choice: "strong",
      privacy: "cheap",
      provider: "anthropic",
      model: "claude-opus-5-5",
      serves: false,
      viaProvider: null,
      viaModel: null,
      reason: "rejected-key",
      httpStatus: 401,
      keySource: "environment",
    },
    {
      node: "tidy",
      name: "Tidy",
      kind: "step",
      choice: "local",
      privacy: "private",
      provider: "ollama",
      model: "qwen3:8b",
      serves: true,
      viaProvider: null,
      viaModel: null,
      reason: null,
      httpStatus: null,
      keySource: null,
    },
    {
      node: "plan_review",
      name: "Plan review",
      kind: "review",
      choice: "judge",
      privacy: "cheap",
      provider: "anthropic",
      model: "claude-fable-5-1",
      serves: false,
      viaProvider: null,
      viaModel: null,
      reason: "rejected-key",
      httpStatus: 401,
      keySource: "environment",
    },
  ],
  offers: [
    { provider: "ollama", kind: "local", models: ["qwen3:8b", "llama3:8b"] },
    { provider: "openai", kind: "cloud", models: ["gpt-5"] },
  ],
};

const render = (preview: StartPreview): string =>
  renderToStaticMarkup(
    <PlaybookStartSheet doc={null} preview={preview} contents={null} onStart={() => {}} onClose={() => {}} />,
  );

const row = (html: string, id: string): string =>
  new RegExp(`<tr data-step="${id}"[^>]*>([\\s\\S]*?)</tr>`).exec(html)?.[1] ?? "";
const startButton = (html: string): string => /<button[^>]*class="pb-run-start"[^>]*>/.exec(html)?.[0] ?? "";

afterEach(() => setLang("en"));

describe("why a step's model does not serve", () => {
  it("names the rejected key with its HTTP status and where the key came from, in English", () => {
    const plan = row(render(PREVIEW), "write_plan");
    expect(plan).toContain("anthropic rejected the key (HTTP 401).");
    expect(plan).toContain("The key comes from the environment of the app.");
    expect(row(render(PREVIEW), "tidy"), "a row that serves names no reason").not.toContain("pb-run-why");
  });

  it("names it in German too", () => {
    setLang("de");
    const plan = row(render(PREVIEW), "write_plan");
    expect(plan).toContain(
      dict["pb.run.why.rejectedKey"].de.replace("{provider}", "anthropic").replace("{status}", "401"),
    );
    expect(plan).toContain(dict["pb.run.keyFrom.environment"].de);
  });

  it("gives a review check its own row beside the steps", () => {
    const review = row(render(PREVIEW), "plan_review");
    expect(review).toContain("Plan review");
    expect(review).toContain(dict["pb.run.review"].en);
    expect(review).toContain("claude-fable-5-1");
  });
});

describe("the model picker of a row", () => {
  it("is preselected with the playbook's model, labelled as its default", () => {
    const plan = row(render(PREVIEW), "write_plan");
    expect(plan).toMatch(/<select[^>]*data-pick="write_plan"/);
    expect(plan).toContain(
      `<option value="" selected="">anthropic claude-opus-5-5 (playbook default)</option>`,
    );
    expect(plan).toContain(dict["pb.run.pickLabel"].en);
  });

  it("offers every provider whose list answered, grouped, and a private row local ones only", () => {
    const html = render(PREVIEW);
    const plan = row(html, "write_plan");
    expect(plan).toContain('<optgroup label="ollama">');
    expect(plan).toContain('<option value="ollama|llama3:8b">llama3:8b</option>');
    expect(plan).toContain('<option value="openai|gpt-5">gpt-5</option>');
    const tidy = row(html, "tidy");
    expect(tidy).toContain('<option value="ollama|llama3:8b">llama3:8b</option>');
    expect(tidy, "a private step is offered no cloud provider").not.toContain("openai");
  });
});

describe("Start", () => {
  it("stays disabled while a row has no model that serves, and a line names the rows that block it", () => {
    const html = render(PREVIEW);
    expect(startButton(html)).toContain("disabled");
    expect(html).toContain(
      "These steps and checks have no model this run can use: Write plan, Plan review. Pick one in their row.",
    );
  });

  it("keeps the old sheet for a server that sends no model rows", () => {
    const html = render({ ...PREVIEW, models: undefined, offers: undefined });
    expect(startButton(html)).not.toContain("disabled");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("pb-run-blocked");
  });

  it("is unblocked by a pick per blocked row, and sends the picks", () => {
    const started: Picks[] = [];
    const select = (tree: El[], id: string): El => {
      const found = tree.find((el) => el.type === "select" && el.props["data-pick"] === id);
      if (found === undefined) throw new Error(`no picker for ${id}`);
      return found;
    };
    const start = (tree: El[]): El =>
      tree.find((el) => el.type === "button" && el.props.className === "pb-run-start") as El;
    const seen: { disabled: unknown; blocked: boolean }[] = [];
    const look = (tree: El[]): void => {
      seen.push({
        disabled: start(tree).props.disabled,
        blocked: tree.some((el) => el.props.className === "pb-run-blocked"),
      });
    };

    const last = drive(
      <PlaybookStartSheet
        doc={null}
        preview={PREVIEW}
        contents={null}
        onStart={(picks) => started.push(picks)}
        onClose={() => {}}
      />,
      [PlaybookStartSheet],
      [
        look,
        (tree) => select(tree, "write_plan").props.onChange?.({ target: { value: "ollama|llama3:8b" } }),
        look,
        (tree) => select(tree, "plan_review").props.onChange?.({ target: { value: "openai|gpt-5" } }),
        look,
        (tree) => start(tree).props.onClick?.(),
        (tree) => select(tree, "write_plan").props.onChange?.({ target: { value: "" } }),
      ],
    );

    expect(seen).toEqual([
      { disabled: true, blocked: true },
      { disabled: true, blocked: true },
      { disabled: false, blocked: false },
    ]);
    expect(started).toEqual([
      {
        write_plan: { provider: "ollama", model: "llama3:8b" },
        plan_review: { provider: "openai", model: "gpt-5" },
      },
    ]);
    expect(start(last).props.disabled, "the playbook's model again blocks its row again").toBe(true);
    const picked = last.filter((el) => el.props.className === "pb-run-picked");
    expect(picked).toHaveLength(1);
  });
});

// Card 584, fix round.
describe("the sheet after a pick and after Start", () => {
  const select = (tree: El[], id: string): El => {
    const found = tree.find((el) => el.type === "select" && el.props["data-pick"] === id);
    if (found === undefined) throw new Error(`no picker for ${id}`);
    return found;
  };
  const chips = (tree: El[]): string[] =>
    tree
      .filter((el) => typeof el.props.className === "string" && el.props.className.startsWith("pb-state"))
      .map((el) => String(el.props.className));

  // Review N8: the failed chip of the playbook's model goes away next to a pick that serves.
  it("drops the failed chip of a row whose pick serves", () => {
    const last = drive(
      <PlaybookStartSheet
        doc={null}
        preview={PREVIEW}
        contents={null}
        onStart={() => {}}
        onClose={() => {}}
      />,
      [PlaybookStartSheet],
      [(tree) => select(tree, "write_plan").props.onChange?.({ target: { value: "ollama|llama3:8b" } })],
    );
    expect(chips(last)).toEqual(["pb-state pb-state--reachable"]);
    expect(
      chips(
        drive(
          <PlaybookStartSheet
            doc={null}
            preview={PREVIEW}
            contents={null}
            onStart={() => {}}
            onClose={() => {}}
          />,
          [PlaybookStartSheet],
          [],
        ),
      ),
    ).toEqual(["pb-state pb-state--failed", "pb-state pb-state--reachable"]);
  });

  // Review N9: the line names steps and checks, and says the run cannot use their model.
  it("names steps and checks in German too", () => {
    setLang("de");
    expect(render(PREVIEW)).toContain(
      "Diese Schritte und Prüfungen haben kein Modell, das dieser Lauf nutzen kann: Write plan, Plan review.",
    );
  });

  // Review N7: the sheet stays open while the server decides, and shows its refusal.
  it("keeps Start disabled while the start is pending and shows a refusal of the server", () => {
    const served = { ...PREVIEW, models: PREVIEW.models?.map((m) => ({ ...m, serves: true, reason: null })) };
    const pending = renderToStaticMarkup(
      <PlaybookStartSheet
        doc={null}
        preview={served}
        contents={null}
        starting
        onStart={() => {}}
        onClose={() => {}}
      />,
    );
    expect(startButton(pending)).toContain("disabled");
    expect(pending).toContain(`>${dict["pb.run.starting"].en}</button>`);

    const refused = renderToStaticMarkup(
      <PlaybookStartSheet
        doc={null}
        preview={served}
        contents={null}
        refusal="The model pick for tidy does not serve: ollama is down."
        onStart={() => {}}
        onClose={() => {}}
      />,
    );
    expect(startButton(refused)).not.toContain("disabled");
    expect(refused).toContain(
      "The server did not start the run: The model pick for tidy does not serve: ollama is down.",
    );
  });
});
