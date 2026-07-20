import { describe, it, expect, beforeEach } from "vitest";
import { fetchSettings, putSettings, originLabel, __setTestHooks } from "./serverSettings";

const view = { effective: { provider: "ollama" }, origins: { provider: { winner: "user", shadowed: ["env"] } },
  layers: {}, files: { user: "/h/.spectro/settings.json" }, workspace: null };

describe("serverSettings", () => {
  let calls: { url: string; init?: RequestInit }[];
  beforeEach(() => {
    calls = [];
    __setTestHooks({ fetchFn: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => view } as Response;
    }) as typeof fetch });
  });

  it("fetches the process view and the session view", async () => {
    await fetchSettings();
    await fetchSettings("abc-123");
    expect(calls[0].url).toBe("/api/settings");
    expect(calls[1].url).toBe("/api/settings?session=abc-123");
  });

  it("puts a patch to the right scope", async () => {
    await putSettings("user", { provider: "ollama" });
    expect(calls[0].url).toBe("/api/settings/user");
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ provider: "ollama" });
    await putSettings("project", { permissionMode: "auto" }, "abc-123");
    expect(calls[1].url).toBe("/api/settings/project?session=abc-123");
  });

  it("labels origins per language", () => {
    expect(originLabel({ winner: "user", shadowed: ["env"] }, "de")).toBe("aus User-Settings · überschattet env");
    expect(originLabel({ winner: "defaults", shadowed: [] }, "en")).toBe("default");
    expect(originLabel(undefined, "de")).toBe("");
  });

  it("throws the server's readable message on a 400", async () => {
    __setTestHooks({ fetchFn: (async () =>
      ({ ok: false, status: 400, json: async () => ({ message: "unknown settings key \"providr\"" }) } as Response)
    ) as typeof fetch });
    await expect(putSettings("user", { providr: "x" })).rejects.toThrow(/providr/);
  });
});
