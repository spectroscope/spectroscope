// Markup pins for the run-analysis affordance (card 294), rendered with
// react-dom/server like the other panel tests — no DOM in this gate. The pins
// that matter: rendering the affordance fires NO fetch (nothing runs at
// import), the consent step names provider/model/address and what leaves
// BEFORE anything is sent, a loopback address earns the stays-on-this-machine
// line, and the result is labelled as the model's READING with a lenient
// prose fallback and an honest error path.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalyzeConsent, AnalyzeResult, AnalyzeRun } from "./AnalyzeRun";
import type { AnalysisState } from "../state/runAnalysis";
import type { RunEvent } from "../events";

afterEach(() => {
  vi.unstubAllGlobals();
});

const events: RunEvent[] = [
  {
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "hello",
    provider: "ollama",
    model: "m",
    ts: 1,
  },
  { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 2 },
];

describe("AnalyzeRun — nothing runs at import", () => {
  it("renders the affordance without firing any request", () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const html = renderToStaticMarkup(<AnalyzeRun viewKey="import:x" events={events} />);
    expect(html).toContain("analyze this run");
    expect(spy).not.toHaveBeenCalled();
  });

  it("renders no result section while idle", () => {
    const html = renderToStaticMarkup(<AnalyzeRun viewKey="import:idle" events={events} />);
    expect(html).not.toContain("an-result");
  });
});

describe("AnalyzeConsent — what the reader is told before the click", () => {
  const digest = { text: "run digest\nprompt: hello", agents: 2, shown: 2, truncated: false };

  it("names provider, model and address for a ready engine", () => {
    const html = renderToStaticMarkup(
      <AnalyzeConsent
        lang="en"
        report={{
          available: true,
          provider: "anthropic",
          model: "claude-opus-5",
          address: "api.anthropic.com",
        }}
        reportError={null}
        digest={digest}
        running={false}
        onRun={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("anthropic");
    expect(html).toContain("claude-opus-5");
    expect(html).toContain("api.anthropic.com");
    expect(html).toContain("leaves this machine");
    expect(html).not.toContain("stays on this machine");
  });

  it("adds the stays-on-this-machine line for a loopback address", () => {
    const html = renderToStaticMarkup(
      <AnalyzeConsent
        lang="en"
        report={{ available: true, provider: "ollama", model: "glm-5.2:cloud", address: "localhost:11434" }}
        reportError={null}
        digest={digest}
        running={false}
        onRun={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("localhost:11434");
    expect(html).toContain("stays on this machine");
  });

  it("shows the digest itself and its size, so what leaves is inspectable", () => {
    const html = renderToStaticMarkup(
      <AnalyzeConsent
        lang="en"
        report={{ available: true, provider: "ollama", model: "m", address: "localhost:11434" }}
        reportError={null}
        digest={digest}
        running={false}
        onRun={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("run digest");
    expect(html).toContain(String(digest.text.length));
  });

  it("says when the digest was capped", () => {
    const html = renderToStaticMarkup(
      <AnalyzeConsent
        lang="en"
        report={{ available: true, provider: "ollama", model: "m", address: "localhost:11434" }}
        reportError={null}
        digest={{ ...digest, truncated: true }}
        running={false}
        onRun={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("capped");
  });

  it("explains an unavailable engine instead of offering a failing button", () => {
    const html = renderToStaticMarkup(
      <AnalyzeConsent
        lang="en"
        report={{ available: false, reason: "provider-is-local", provider: "spectro-local" }}
        reportError={null}
        digest={digest}
        running={false}
        onRun={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("built-in model");
    expect(html).toContain("disabled");
  });

  it("speaks German too", () => {
    const html = renderToStaticMarkup(
      <AnalyzeConsent
        lang="de"
        report={{ available: true, provider: "ollama", model: "m", address: "localhost:11434" }}
        reportError={null}
        digest={digest}
        running={false}
        onRun={() => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("bleibt auf diesem Rechner");
  });
});

describe("AnalyzeResult — the model's reading, labelled as one", () => {
  const done = (text: string): AnalysisState => ({
    status: "done",
    meta: { provider: "ollama", model: "glm-5.2:cloud", address: "localhost:11434" },
    text,
    error: null,
  });

  it("renders a structured answer as summary plus per-agent readings", () => {
    const html = renderToStaticMarkup(
      <AnalyzeResult
        lang="en"
        state={done('{"summary":"A tidy run.","agents":[{"id":"c1","reading":"Scouted well."}]}')}
        onAgain={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(html).toContain("A tidy run.");
    expect(html).toContain("c1");
    expect(html).toContain("Scouted well.");
    expect(html).toContain("reading");
    expect(html).toContain("not a measurement");
    expect(html).toContain("glm-5.2:cloud");
  });

  it("renders a prose answer as prose, honestly, instead of crashing", () => {
    const html = renderToStaticMarkup(
      <AnalyzeResult
        lang="en"
        state={done("The run went fine, nothing to report.")}
        onAgain={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(html).toContain("The run went fine, nothing to report.");
    expect(html).toContain("not a measurement");
  });

  it("renders the server's readable error verbatim", () => {
    const html = renderToStaticMarkup(
      <AnalyzeResult
        lang="en"
        state={{ status: "error", meta: null, text: "", error: "anthropic needs ANTHROPIC_API_KEY" }}
        onAgain={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(html).toContain("anthropic needs ANTHROPIC_API_KEY");
  });

  it("says when the model is still reading", () => {
    const html = renderToStaticMarkup(
      <AnalyzeResult
        lang="en"
        state={{ status: "running", meta: null, text: "", error: null }}
        onAgain={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(html).toContain("reading the run");
  });

  it("renders nothing at all while idle", () => {
    const html = renderToStaticMarkup(
      <AnalyzeResult
        lang="en"
        state={{ status: "idle", meta: null, text: "", error: null }}
        onAgain={() => {}}
        onDiscard={() => {}}
      />,
    );
    expect(html).toBe("");
  });
});
