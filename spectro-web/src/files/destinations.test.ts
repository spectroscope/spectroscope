// Card 605: where a session's content went (design section 4, proposal R5).
// One case per rule: the host classes, the grouping of llm_exchange events,
// the run_start fallback and the destinations a finding reached.

import { describe, expect, it } from "vitest";
import { TITLE_AGENT_ID, type RunEvent } from "../events";
import { destinations, hostWhere, reachedBy, reachIndex } from "./destinations";

const T0 = 1_760_000_000_000;

function exchange(over: object = {}): RunEvent {
  return {
    type: "llm_exchange",
    xid: "x",
    agentId: "main",
    kind: "chat",
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    transport: "http",
    url: "https://api.anthropic.com/v1/messages",
    status: 200,
    requestBytes: 100,
    responseBytes: 10,
    responseLines: 1,
    aborted: false,
    fidelity: "bytes",
    durationMs: 5,
    ts: T0,
    ...over,
  } as unknown as RunEvent;
}

function runStart(over: object = {}): RunEvent {
  return { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: T0, ...over } as RunEvent;
}

function filler(): RunEvent {
  return { type: "text_delta", agentId: "main", text: "x", ts: T0 } as RunEvent;
}

describe("hostWhere", () => {
  it("hosts are classed", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]) {
      expect(hostWhere(host, "qwen2.5:7b"), host).toBe("this-machine");
    }
    expect(hostWhere("localhost", "minimax-m3:cloud")).toBe("local-cloud");
    expect(hostWhere("localhost", "glm-5-cloud")).toBe("local-cloud");
    for (const host of [
      "10.1.2.3",
      "172.20.0.4",
      "192.168.1.9",
      "100.64.10.20",
      "nas.local",
      "box.tail1234.ts.net",
    ]) {
      expect(hostWhere(host, "qwen2.5:7b"), host).toBe("network");
    }
    for (const host of ["172.32.0.1", "api.anthropic.com"]) {
      expect(hostWhere(host, "qwen2.5:7b"), host).toBe("cloud");
    }
  });

  it("the private ranges end where their prefix ends", () => {
    for (const host of ["172.16.0.1", "172.31.255.255", "100.64.0.1", "100.127.255.255", "127.8.9.10"]) {
      expect(hostWhere(host, "m"), host).not.toBe("cloud");
    }
    for (const host of ["172.15.255.255", "100.63.255.255", "100.128.0.1", "192.169.0.1", "11.0.0.1"]) {
      expect(hostWhere(host, "m"), host).toBe("cloud");
    }
  });

  it("an octet over 255 is a name, not an address", () => {
    expect(hostWhere("10.300.0.1", "m")).toBe("cloud");
    expect(hostWhere("127.0.0.300", "m")).toBe("cloud");
  });

  it("a cloud model behind a loopback or private-network host is a local cloud", () => {
    expect(hostWhere("127.0.0.1", " minimax-m3:CLOUD ")).toBe("local-cloud");
    for (const host of [
      "10.1.2.3",
      "192.168.1.9",
      "100.64.10.20",
      "nas.local",
      "box.tail1234.ts.net",
      "fd12::1",
    ]) {
      expect(hostWhere(host, "minimax-m3:cloud"), host).toBe("local-cloud");
      expect(hostWhere(host, "glm-5-cloud"), host).toBe("local-cloud");
    }
    expect(hostWhere("api.example.com", "minimax-m3:cloud")).toBe("cloud");
    expect(hostWhere("172.32.0.1", "minimax-m3:cloud")).toBe("cloud");
    expect(hostWhere("localhost", "cloudy")).toBe("this-machine");
    expect(hostWhere("10.1.2.3", "cloudy")).toBe("network");
  });

  it("IPv6 unique-local and link-local are the network, IPv4-mapped addresses read as IPv4", () => {
    for (const host of ["fc00::1", "fd12:3456::1", "[fdff:ffff::1]", "fe80::1", "febf:1::2"]) {
      expect(hostWhere(host, "m"), host).toBe("network");
    }
    for (const host of ["fbff::1", "fe00::1", "fec0::1", "2001:db8::1", "fc::1", "fd12x::1"]) {
      expect(hostWhere(host, "m"), host).toBe("cloud");
    }
    for (const host of ["::ffff:127.0.0.1", "::ffff:7f00:1", "[::ffff:7f00:1]", "::ffff:7f12:3456"]) {
      expect(hostWhere(host, "m"), host).toBe("this-machine");
    }
    expect(hostWhere("::ffff:10.0.0.1", "m")).toBe("network");
    expect(hostWhere("::ffff:a00:1", "m")).toBe("network");
    expect(hostWhere("::ffff:8.8.8.8", "m")).toBe("cloud");
    expect(hostWhere("::ffff:808:808", "m")).toBe("cloud");
  });

  it("a trailing dot on a host is ignored", () => {
    expect(hostWhere("localhost.", "m")).toBe("this-machine");
    expect(hostWhere("127.0.0.1.", "m")).toBe("this-machine");
    expect(hostWhere("nas.local.", "m")).toBe("network");
    expect(hostWhere("box.tail1234.ts.net.", "m")).toBe("network");
    expect(hostWhere(".", "m")).toBe("unknown");
  });

  it("names compare in lower case and an empty host is unknown", () => {
    expect(hostWhere("EVO.LOCAL", "m")).toBe("network");
    expect(hostWhere("LocalHost", "m")).toBe("this-machine");
    expect(hostWhere("", "m")).toBe("unknown");
    expect(hostWhere("[]", "m")).toBe("unknown");
  });
});

describe("destinations", () => {
  it("exchanges group by provider, model and host", () => {
    const events = [
      exchange({ requestBytes: 100 }),
      exchange({ requestBytes: 400 }),
      exchange({ provider: "ollama", model: "qwen2.5:7b", url: "http://localhost:11434/api/chat" }),
    ];
    const out = destinations(events);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      key: "anthropic|claude-sonnet-4-5|api.anthropic.com",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      host: "api.anthropic.com",
      where: "cloud",
      requests: 2,
      largestRequest: 400,
      recorded: true,
    });
    expect(out[1]).toMatchObject({
      key: "ollama|qwen2.5:7b|localhost",
      host: "localhost",
      where: "this-machine",
      requests: 1,
      largestRequest: 100,
      recorded: true,
    });
  });

  it("the largest request is the maximum, not the last or the sum", () => {
    const out = destinations([
      exchange({ requestBytes: 300 }),
      exchange({ requestBytes: 900 }),
      exchange({ requestBytes: 200 }),
    ]);
    expect(out[0].largestRequest).toBe(900);
    expect(destinations([exchange({ requestBytes: "big" })])[0].largestRequest).toBeNull();
  });

  it("rows keep the order of first appearance", () => {
    const out = destinations([
      exchange({ provider: "ollama", model: "a", url: "http://localhost:11434/api/chat" }),
      exchange(),
      exchange({ provider: "ollama", model: "a", url: "http://localhost:11434/api/chat" }),
      exchange({ provider: "lmstudio", model: "b", url: "http://100.64.10.20:1234/v1/chat/completions" }),
    ]);
    expect(out.map((d) => d.key)).toEqual([
      "ollama|a|localhost",
      "anthropic|claude-sonnet-4-5|api.anthropic.com",
      "lmstudio|b|100.64.10.20",
    ]);
    expect(out[2].where).toBe("network");
  });

  it("a loopback URL with a cloud model is a local cloud and keeps the bracketed IPv6 host", () => {
    const out = destinations([
      exchange({ provider: "ollama", model: "minimax-m3:cloud", url: "http://127.0.0.1:11434/api/chat" }),
      exchange({ provider: "ollama", model: "qwen2.5:7b", url: "http://[::1]:11434/api/chat" }),
      exchange({ provider: "ollama", model: "qwen2.5:7b", url: "http://[fd00::5]:11434/api/chat" }),
      exchange({ provider: "ollama", model: "qwen2.5:7b", url: "http://[::ffff:127.0.0.1]:11434/api/chat" }),
      exchange({ provider: "ollama", model: "minimax-m3:cloud", url: "http://nas.local.:11434/api/chat" }),
    ]);
    expect(out[0]).toMatchObject({ host: "127.0.0.1", where: "local-cloud" });
    expect(out[1]).toMatchObject({ host: "[::1]", where: "this-machine" });
    expect(out[2]).toMatchObject({ host: "[fd00::5]", where: "network" });
    expect(out[3]).toMatchObject({ host: "[::ffff:7f00:1]", where: "this-machine" });
    expect(out[4]).toMatchObject({ host: "nas.local.", where: "local-cloud" });
  });

  it("a URL that does not parse gives no host and the provider's place", () => {
    for (const url of ["copilot-runtime", "localhost:11434", "", 42]) {
      const out = destinations([exchange({ provider: "copilot", model: "gpt-5", url })]);
      expect(out, String(url)).toEqual([
        {
          key: "copilot|gpt-5|",
          provider: "copilot",
          model: "gpt-5",
          host: null,
          where: "cloud",
          requests: 1,
          largestRequest: 100,
          recorded: true,
        },
      ]);
    }
    const where = (provider: string | undefined): string =>
      destinations([exchange({ provider, url: "copilot-runtime" })])[0].where;
    expect(where("spectro-local")).toBe("this-machine");
    expect(where("ollama")).toBe("unknown");
    expect(where("constructor")).toBe("unknown");
    expect(where(undefined)).toBe("unknown");
  });

  it("every kind of exchange counts as a destination", () => {
    const out = destinations([
      exchange({ kind: "image" }),
      exchange({ kind: "stt", agentId: TITLE_AGENT_ID }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].requests).toBe(2);
  });

  it("the run_start fallback", () => {
    expect(destinations([runStart({ provider: "ollama", model: "qwen2.5:7b" })])).toEqual([
      {
        key: "ollama|qwen2.5:7b|",
        provider: "ollama",
        model: "qwen2.5:7b",
        host: null,
        where: "unknown",
        requests: 0,
        largestRequest: null,
        recorded: false,
      },
    ]);
    expect(destinations([runStart({ provider: "spectro-local" })])[0].where).toBe("this-machine");
    expect(destinations([runStart({ provider: "scripted" })])[0].where).toBe("this-machine");
    for (const provider of ["anthropic", "openai", "gemini", "copilot", "openrouter"]) {
      expect(destinations([runStart({ provider })])[0].where, provider).toBe("cloud");
    }
    for (const provider of ["lmstudio", "llamacpp", "openai-compat", "constructor", "toString"]) {
      expect(destinations([runStart({ provider })])[0].where, provider).toBe("unknown");
    }
    const none = destinations([runStart()]);
    expect(none).toHaveLength(1);
    expect(none[0]).toMatchObject({
      provider: null,
      model: null,
      host: null,
      where: "unknown",
      recorded: false,
    });
  });

  it("an imported session without exchanges and without a provider still gets one row", () => {
    expect(destinations([])).toEqual([
      {
        key: "||",
        provider: null,
        model: null,
        host: null,
        where: "unknown",
        requests: 0,
        largestRequest: null,
        recorded: false,
      },
    ]);
    const imported = destinations([runStart({ model: "claude-opus-4-1" }), filler()]);
    expect(imported).toEqual([
      expect.objectContaining({ provider: null, model: "claude-opus-4-1", where: "unknown" }),
    ]);
  });

  it("the fallback reads top-level runs only, one row per distinct provider and model", () => {
    const out = destinations([
      runStart({ provider: "anthropic", model: "m1" }),
      runStart({ provider: "openai", model: "m2", agentId: "helper-1", parentId: "main" }),
      runStart({ provider: "openai", model: "m3", agentId: TITLE_AGENT_ID }),
      runStart({ provider: "anthropic", model: "m1" }),
      runStart({ provider: "ollama", model: "m4" }),
    ]);
    expect(out.map((d) => d.key)).toEqual(["anthropic|m1|", "ollama|m4|"]);
  });

  it("recorded exchanges win over run_start", () => {
    const out = destinations([runStart({ provider: "openai", model: "m2" }), exchange()]);
    expect(out.map((d) => d.key)).toEqual(["anthropic|claude-sonnet-4-5|api.anthropic.com"]);
  });
});

describe("reachedBy", () => {
  const cloud = { url: "https://api.anthropic.com/v1/messages" };
  const local = { provider: "ollama", model: "q", url: "http://localhost:11434/api/chat" };

  it("reachedBy follows the agent", () => {
    const events = [
      runStart(),
      filler(),
      filler(),
      filler(),
      filler(),
      filler(),
      exchange({ agentId: "main", ...cloud }),
      exchange({ agentId: "helper-1", ...local }),
    ];
    const all = destinations(events);
    expect(reachedBy(reachIndex(events), "main", 5, all)).toEqual([
      "anthropic|claude-sonnet-4-5|api.anthropic.com",
    ]);
    expect(reachedBy(reachIndex(events), "main", 6, all)).toEqual(all.map((d) => d.key));
    expect(reachedBy(reachIndex(events), "nobody", 0, all)).toEqual(all.map((d) => d.key));
  });

  it("only chat and compaction exchanges after the call count, in the order of the rows", () => {
    const events = [
      exchange({ agentId: "main", ...cloud }),
      filler(),
      exchange({ agentId: "main", kind: "image", ...cloud }),
      exchange({ agentId: "main", kind: "compaction", ...local }),
      exchange({ agentId: "main", kind: "chat", ...cloud }),
      exchange({
        agentId: "main",
        kind: "stt",
        provider: "x",
        model: "w",
        url: "https://stt.example.com/v1",
      }),
    ];
    const all = destinations(events);
    expect(all).toHaveLength(3);
    expect(reachedBy(reachIndex(events), "main", 1, all)).toEqual([
      "anthropic|claude-sonnet-4-5|api.anthropic.com",
      "ollama|q|localhost",
    ]);
    expect(reachedBy(reachIndex(events), "main", 3, all)).toEqual([
      "anthropic|claude-sonnet-4-5|api.anthropic.com",
    ]);
    expect(reachedBy(reachIndex(events), "main", 4, all)).toEqual(all.map((d) => d.key));
  });

  it("keys come in the order of the rows, not of the agent's own first exchange", () => {
    const events = [
      exchange({ agentId: "helper-1", ...cloud }),
      exchange({ agentId: "helper-1", provider: "lmstudio", model: "b", url: "http://nas.local:1234/v1" }),
      exchange({ agentId: "main", ...local }),
      exchange({ agentId: "main", ...cloud }),
    ];
    const all = destinations(events);
    expect(all).toHaveLength(3);
    expect(reachedBy(reachIndex(events), "main", -1, all)).toEqual([
      "anthropic|claude-sonnet-4-5|api.anthropic.com",
      "ollama|q|localhost",
    ]);
  });

  it("two indexes built from two lists answer independently", () => {
    const a = [exchange({ agentId: "main", ...cloud })];
    const b = [exchange({ agentId: "main", ...local })];
    const ia = reachIndex(a);
    const ib = reachIndex(b);
    expect(reachedBy(ia, "main", -1, destinations(a))).toEqual([
      "anthropic|claude-sonnet-4-5|api.anthropic.com",
    ]);
    expect(reachedBy(ib, "main", -1, destinations(b))).toEqual(["ollama|q|localhost"]);
    expect(reachedBy(ia, "main", -1, destinations(a))).toEqual([
      "anthropic|claude-sonnet-4-5|api.anthropic.com",
    ]);
  });

  it("an index holds the list as it was built; a new event needs a new index", () => {
    // The old index knows no exchange of main and gives every key; a new one gives a strict subset.
    const events: RunEvent[] = [exchange({ agentId: "helper-1", ...cloud }), filler()];
    const before = reachIndex(events);
    events.push(exchange({ agentId: "main", ...local }));
    const grown = destinations(events);
    expect(grown).toHaveLength(2);
    expect(reachedBy(before, "main", 0, grown)).toEqual(grown.map((d) => d.key));
    expect(reachedBy(reachIndex(events), "main", 0, grown)).toEqual(["ollama|q|localhost"]);
  });

  it("one index and 2,500 lookups on 10,000 events stay well under a second", () => {
    const events: RunEvent[] = [];
    for (let i = 0; i < 10_000; i++) {
      events.push(
        i % 2 === 0 ? filler() : exchange({ agentId: i % 4 === 1 ? "main" : "helper-1", ...cloud }),
      );
    }
    const all = destinations(events);
    const start = performance.now();
    const index = reachIndex(events);
    for (let i = 0; i < 2_500; i++) reachedBy(index, "main", i * 4, all);
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});
