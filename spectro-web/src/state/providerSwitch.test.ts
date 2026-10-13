// Card 556, criterion 3 (owner, 2026-10-12: "Auch Standard für neue Chats"):
// a model picked in a stored session becomes the default for new chats, as a
// pick in a live session does since card 459. The default is written only
// when the server confirms the switch.
//
// Fix round 1: the confirmation is the server's answer to this pick and
// nothing else. Every set_provider carries an ask id, and the provider_info
// that answers it echoes the id. A record that opens for a stored session
// also announces the pair its history names (at connect, at the wake), with
// no id; a refused switch answers with an error and no provider_info. Neither
// writes the default, whatever pair it names.
//
// A pick whose resume ends without continuing the session (a later navigation
// won, the history could not be fetched) is no longer waited for, and a pick
// the resume failed to deliver says so in the chat.

import { describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import { initialState } from "./reducer";
import { askedSwitch, confirmedSwitch, switchFrame, switchLost, switchNotSent } from "./providerSwitch";

const info = (provider: string, model: string, answers?: string): RunEvent =>
  ({
    type: "provider_info",
    provider,
    model,
    host: "local",
    ...(answers !== undefined ? { answers } : {}),
  }) as unknown as RunEvent;
const refused = { type: "error", agentId: "main", message: 'Unknown provider: "bogus"', ts: 5 } as RunEvent;
const other = { type: "workspace_info", path: "/tmp/x" } as unknown as RunEvent;

const STORED = "20261012-090000-abcd";

describe("who asked, and the frame that asks", () => {
  it("a live session asks on the record in view", () => {
    expect(askedSwitch(null, "s2", "ollama", "qwen3", "p1")).toEqual({
      key: "s2",
      sessionId: null,
      provider: "ollama",
      model: "qwen3",
      ask: "p1",
    });
  });

  it("a stored session asks by its id, before any record holds it", () => {
    expect(askedSwitch(STORED, "s2", "ollama", "qwen3", "p1")).toEqual({
      key: null,
      sessionId: STORED,
      provider: "ollama",
      model: "qwen3",
      ask: "p1",
    });
  });

  it("the frame carries the ask id the answer echoes, and a model only when one was picked", () => {
    expect(switchFrame(askedSwitch(STORED, "s2", "ollama", "qwen3", "p1"))).toEqual({
      type: "set_provider",
      provider: "ollama",
      model: "qwen3",
      ask: "p1",
    });
    expect(switchFrame(askedSwitch(null, "s2", "ollama", "", "p2"))).toEqual({
      type: "set_provider",
      provider: "ollama",
      ask: "p2",
    });
  });
});

describe("a live session's switch", () => {
  const asked = askedSwitch(null, "s2", "ollama", "qwen3", "p1");

  it("is confirmed by the answer to its ask on the record that asked", () => {
    expect(
      confirmedSwitch(asked, { key: "s2", sessionId: null }, [other, info("ollama", "qwen3", "p1")]),
    ).toEqual({ provider: "ollama", model: "qwen3" });
  });

  it("is not confirmed by a provider_info that answers no ask, even one naming the pair", () => {
    expect(confirmedSwitch(asked, { key: "s2", sessionId: null }, [info("ollama", "qwen3")])).toBeNull();
  });

  it("is not confirmed by another record, nor by a batch without provider_info, nor when nobody asked", () => {
    expect(
      confirmedSwitch(asked, { key: "s3", sessionId: null }, [info("ollama", "qwen3", "p1")]),
    ).toBeNull();
    expect(confirmedSwitch(asked, { key: "s2", sessionId: null }, [other])).toBeNull();
    expect(confirmedSwitch(null, { key: "s2", sessionId: null }, [info("ollama", "qwen3", "p1")])).toBeNull();
  });
});

describe("a stored session's switch", () => {
  const asked = askedSwitch(STORED, "s1", "ollama", "qwen3", "p4");
  const record = { key: "s4", sessionId: STORED };

  it("is confirmed by the answer to its ask, naming exactly the pair picked", () => {
    expect(confirmedSwitch(asked, record, [info("ollama", "qwen3", "p4")])).toEqual({
      provider: "ollama",
      model: "qwen3",
    });
  });

  it("is confirmed when the restored pair and the answer share one batch", () => {
    const batch = [info("llamacpp", "old-model"), other, info("ollama", "qwen3", "p4")];
    expect(confirmedSwitch(asked, record, batch)).toEqual({ provider: "ollama", model: "qwen3" });
  });

  it("is not confirmed by the pair the record announced on its own, even when it is the pair picked", () => {
    expect(confirmedSwitch(asked, record, [info("llamacpp", "old-model")])).toBeNull();
    expect(confirmedSwitch(asked, record, [info("ollama", "qwen3")]), "connect frame, no ask").toBeNull();
  });

  it("a refusal writes nothing: an error, then only frames that answer no ask", () => {
    expect(confirmedSwitch(asked, record, [refused])).toBeNull();
    expect(confirmedSwitch(asked, record, [refused, info("llamacpp", "old-model")])).toBeNull();
    expect(confirmedSwitch(asked, record, [info("ollama", "qwen3")])).toBeNull();
  });

  it("is not confirmed by the answer to another ask, nor by an answer naming another pair", () => {
    expect(confirmedSwitch(asked, record, [info("ollama", "qwen3", "p3")])).toBeNull();
    expect(confirmedSwitch(asked, record, [info("ollama", "other-model", "p4")])).toBeNull();
    expect(confirmedSwitch(asked, record, [info("lmstudio", "qwen3", "p4")])).toBeNull();
  });

  it("is not confirmed by the record in view, nor by another session's record", () => {
    expect(
      confirmedSwitch(asked, { key: "s1", sessionId: null }, [info("ollama", "qwen3", "p4")]),
    ).toBeNull();
    expect(
      confirmedSwitch(asked, { key: "s1", sessionId: "20261012-090000-other" }, [
        info("ollama", "qwen3", "p4"),
      ]),
    ).toBeNull();
  });

  it("a pick with no model takes the model the server named in its answer to that pick", () => {
    const bare = askedSwitch(STORED, "s1", "ollama", "", "p5");
    expect(confirmedSwitch(bare, record, [info("ollama", "llama3.2", "p5")])).toEqual({
      provider: "ollama",
      model: "llama3.2",
    });
    expect(confirmedSwitch(bare, record, [info("ollama", "llama3.2")]), "no ask: not the answer").toBeNull();
    expect(confirmedSwitch(bare, record, [info("llamacpp", "old-model", "p5")])).toBeNull();
  });
});

describe("a pick whose resume ends without continuing the session", () => {
  const asked = askedSwitch(STORED, "s1", "ollama", "qwen3", "p6");
  const mode: ClientMessage = { type: "set_permission_mode", mode: "auto" };

  it("is lost when the frames the resume dropped carry it", () => {
    expect(switchLost(asked, STORED, [mode, switchFrame(asked)])).toBe(true);
  });

  it("is not lost through another session's resume, another pick's frame or no frame at all", () => {
    expect(switchLost(asked, "20261012-090000-other", [switchFrame(asked)])).toBe(false);
    expect(switchLost(asked, STORED, [switchFrame(askedSwitch(STORED, "s1", "ollama", "qwen3", "p5"))])).toBe(
      false,
    );
    expect(switchLost(asked, STORED, [mode])).toBe(false);
    expect(switchLost(null, STORED, [switchFrame(asked)])).toBe(false);
  });

  it("a failed pick leaves a warning line in the chat that names the pair", () => {
    const state = switchNotSent(initialState, asked);
    const last = state.turns[state.turns.length - 1];
    expect(state.turns).toHaveLength(initialState.turns.length + 1);
    expect(last).toMatchObject({
      kind: "info",
      tone: "warn",
      infoKey: "chat.switchNotSent",
      infoVars: { pair: "ollama qwen3" },
    });
    const bare = switchNotSent(initialState, askedSwitch(STORED, "s1", "ollama", "", "p7"));
    expect(bare.turns[bare.turns.length - 1]).toMatchObject({ infoVars: { pair: "ollama" } });
  });
});
