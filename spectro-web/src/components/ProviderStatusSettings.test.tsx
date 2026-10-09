import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderStatusSettings, ageLabel, stateLabelKey } from "./ProviderStatusSettings";
import { __resetProviderRegistry, __seedProviderRows } from "../state/providerRegistry";
import { dict, t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

beforeEach(() => {
  __resetProviderRegistry();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }),
  );
});
afterEach(() => vi.unstubAllGlobals());

/** The markup of one table row, found by the provider label in its first cell. */
function rowOf(html: string, label: string): string {
  const rows = html.match(/<tr class="prov-row[^"]*">.*?<\/tr>/g) ?? [];
  const row = rows.find((r) => r.includes(`>${label}<`));
  if (!row) throw new Error(`no row for ${label}`);
  return row;
}

describe("the provider overview", () => {
  it("renders one row per provider with its state in words and a Check button", () => {
    __seedProviderRows([
      {
        id: "anthropic",
        kind: "cloud",
        state: "needs-key",
        keyPresent: false,
        endpoint: null,
        models: [],
        live: false,
        reason: null,
        checkedAt: 0,
      },
      {
        id: "ollama",
        kind: "local",
        state: "reachable",
        keyPresent: false,
        endpoint: "http://localhost:11434",
        models: ["qwen3:8b"],
        live: true,
        reason: null,
        checkedAt: 1,
      },
      {
        id: "spectro-local",
        kind: "builtin",
        state: "configured",
        keyPresent: false,
        endpoint: null,
        models: [],
        live: false,
        reason: null,
        checkedAt: 0,
      },
    ]);
    const html = renderToStaticMarkup(<ProviderStatusSettings anchorId="providers" />);
    const lang = currentLang();
    expect((html.match(/<tr class="prov-row/g) ?? []).length).toBe(3);
    expect(html).toContain(t(lang, "prov.state.needs-key"));
    expect(html).toContain(t(lang, "prov.state.reachable"));
    expect(html).toContain("http://localhost:11434");
    expect(html).toContain("built-in");
    expect(html).not.toContain(">spectro-local<");
    // The server never checks a provider without its key or the built-in one,
    // so only the reachable local row carries a Check button.
    expect((html.match(/prov-check-one/g) ?? []).length).toBe(1);
    expect(rowOf(html, "ollama")).toContain("prov-check-one");
    expect(rowOf(html, "anthropic")).not.toContain("prov-check-one");
    expect(rowOf(html, "built-in")).not.toContain("prov-check-one");
    expect(rowOf(html, "ollama")).toContain(t(lang, "prov.models", { n: 1 }));
    expect(html).toContain("prov-check-all");
  });

  it("names the reason and the address of a failed check", () => {
    __seedProviderRows([
      {
        id: "lmstudio",
        kind: "local",
        state: "failed",
        keyPresent: false,
        endpoint: "http://127.0.0.1:1",
        models: [],
        live: false,
        reason: "timeout",
        checkedAt: 1,
      },
    ]);
    const html = renderToStaticMarkup(<ProviderStatusSettings anchorId="providers" />);
    const row = rowOf(html, "lmstudio");
    expect(row).toContain(t(currentLang(), "prov.state.failed"));
    expect(row).toContain("timeout");
    expect(row).toContain("http://127.0.0.1:1");
    expect(row).toContain("prov-row--failed");
  });

  it("shows key presence as a word, never a value", () => {
    __seedProviderRows([
      {
        id: "openai",
        kind: "cloud",
        state: "configured",
        keyPresent: true,
        endpoint: null,
        models: [],
        live: false,
        reason: null,
        checkedAt: 0,
      },
    ]);
    const html = renderToStaticMarkup(<ProviderStatusSettings anchorId="providers" />);
    const lang = currentLang();
    // Read in the row's own cell: the hint above the table uses the same word.
    const row = rowOf(html, "openai");
    expect(row).toContain(`<td>${t(lang, "prov.keyYes")}</td>`);
    expect(row).not.toContain(`<td>${t(lang, "prov.keyNo")}</td>`);
    expect(html).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("marks a curated list as curated, never as live", () => {
    __seedProviderRows([
      {
        id: "gemini",
        kind: "cloud",
        state: "reachable",
        keyPresent: true,
        endpoint: null,
        models: ["a", "b"],
        live: false,
        reason: null,
        checkedAt: 1,
      },
    ]);
    const html = renderToStaticMarkup(<ProviderStatusSettings anchorId="providers" />);
    const lang = currentLang();
    expect(html).toContain(t(lang, "prov.modelsFallback", { n: 2 }));
    expect(html).not.toContain(t(lang, "prov.models", { n: 2 }));
  });

  it("has every state word in both languages", () => {
    for (const state of ["needs-key", "needs-download", "configured", "reachable", "failed"]) {
      const key = stateLabelKey(state as never);
      expect(dict[key].de.length).toBeGreaterThan(0);
      expect(dict[key].en.length).toBeGreaterThan(0);
    }
  });

  it("phrases the age of a check", () => {
    expect(ageLabel(0, 10_000, "en")).toBe(t("en", "prov.never"));
    expect(ageLabel(10_000 - 5_000, 10_000, "en")).toBe(t("en", "prov.ago", { s: 5 }));
  });
});
