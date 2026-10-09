import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetProviderRegistry,
  checkProviders,
  providerRows,
  refreshProviders,
  rowFor,
} from "./providerRegistry";

let fetchMock: ReturnType<typeof vi.fn>;

function answer(body: unknown, status = 200): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

const ollama = {
  id: "ollama", kind: "local", state: "failed", keyPresent: false,
  endpoint: "http://localhost:11434", models: [], live: false, reason: "refused", checkedAt: 5,
};

beforeEach(() => {
  __resetProviderRegistry();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("the provider registry store", () => {
  it("reads the rows from GET /api/providers", async () => {
    answer({ providers: [ollama] });
    await refreshProviders();
    expect(fetchMock).toHaveBeenCalledWith("/api/providers");
    expect(providerRows().map((r) => r.id)).toEqual(["ollama"]);
    expect(rowFor("ollama")?.reason).toBe("refused");
  });

  it("posts a check and replaces the rows with the answer", async () => {
    answer({ providers: [{ ...ollama, state: "reachable", reason: null, models: ["qwen3:8b"], live: true }] });
    await checkProviders("local");
    expect(fetchMock).toHaveBeenCalledWith("/api/providers/check?provider=local", { method: "POST" });
    expect(rowFor("ollama")?.state).toBe("reachable");
  });

  it("keeps the rows it has when the server answers with an error", async () => {
    answer({ providers: [ollama] });
    await refreshProviders();
    answer({}, 500);
    await checkProviders("ollama");
    expect(rowFor("ollama")?.state).toBe("failed");
  });

  it("starts empty and rowFor answers undefined for an unknown id", () => {
    expect(providerRows()).toEqual([]);
    expect(rowFor("vllm")).toBeUndefined();
  });
});
