// Card 493: the Local mode switch, the pure half. What the server's
// local_mode_info frame says, what the gear sends back, and how a row's
// value reads and parses.

import { describe, expect, it, vi } from "vitest";
import {
  editLocalModeValue,
  formatRowValue,
  parseLocalModeInfo,
  parseRowInput,
  parseToolUse,
  resetLocalModeValue,
  switchLocalMode,
  toolUseUrl,
  type LocalModeRow,
} from "./localMode";

const frame = {
  type: "local_mode_info",
  on: true,
  rows: [
    { key: "sessionsPerChat", value: 2, preset: 3, changed: true, floor: 2 },
    {
      key: "toolGroupsOff",
      value: ["browser", "launch", "images", "roles"],
      preset: ["browser", "launch", "images", "roles"],
      changed: false,
    },
    { key: "readSharePercent", value: 10, preset: 10, changed: false, floor: 1 },
    { key: "careParagraph", value: "on", preset: "on", changed: false },
  ],
};

describe("parseLocalModeInfo", () => {
  it("reads the switch and its rows in the server's order", () => {
    const info = parseLocalModeInfo(frame);
    expect(info?.on).toBe(true);
    expect(info?.rows.map((row) => row.key)).toEqual([
      "sessionsPerChat",
      "toolGroupsOff",
      "readSharePercent",
      "careParagraph",
    ]);
    expect(info?.rows[0]).toEqual({ key: "sessionsPerChat", value: 2, preset: 3, changed: true, floor: 2 });
    expect(info?.rows[1]?.floor).toBeNull();
  });

  it("is no frame at all without the switch or the rows", () => {
    expect(parseLocalModeInfo({ type: "local_mode_info", rows: [] })).toBeNull();
    expect(parseLocalModeInfo({ type: "local_mode_info", on: true })).toBeNull();
    expect(parseLocalModeInfo(null)).toBeNull();
  });

  it("drops a malformed row and keeps the rest", () => {
    const info = parseLocalModeInfo({ ...frame, rows: [{ value: 1 }, ...frame.rows] });
    expect(info?.rows).toHaveLength(4);
  });

  it("carries the reason a save did not happen", () => {
    expect(parseLocalModeInfo({ ...frame, saveError: "the folder is gone" })?.saveError).toBe(
      "the folder is gone",
    );
    expect(parseLocalModeInfo(frame)?.saveError).toBeUndefined();
  });
});

describe("what the gear sends", () => {
  it("switches with one frame", () => {
    const send = vi.fn(() => true);
    switchLocalMode(true, send);
    switchLocalMode(false, send);
    expect(send.mock.calls).toEqual([
      [{ type: "set_local_mode", on: true }],
      [{ type: "set_local_mode", on: false }],
    ]);
  });

  it("edits one value and resets one key", () => {
    const send = vi.fn(() => true);
    editLocalModeValue("sessionsPerChat", 2, send);
    resetLocalModeValue("sessionsPerChat", send);
    expect(send.mock.calls).toEqual([
      [{ type: "set_local_mode", values: { sessionsPerChat: 2 } }],
      [{ type: "set_local_mode", reset: ["sessionsPerChat"] }],
    ]);
  });
});

describe("a row's value", () => {
  const row = (key: string, value: unknown): LocalModeRow => ({
    key,
    value,
    preset: null,
    changed: false,
    floor: null,
  });

  it("reads as the gear shows it", () => {
    expect(formatRowValue(row("toolGroupsOff", ["browser", "launch"]))).toBe("browser, launch");
    expect(formatRowValue(row("toolGroupsOff", []))).toBe("");
    expect(formatRowValue(row("readSharePercent", 10))).toBe("10");
    expect(formatRowValue(row("sessionsPerChat", null))).toBe("");
    expect(formatRowValue(row("careParagraph", "on"))).toBe("on");
  });

  it("parses a typed number against the row's floor", () => {
    expect(parseRowInput("2", 2)).toEqual({ ok: true, value: 2 });
    expect(parseRowInput(" 12 ", 1)).toEqual({ ok: true, value: 12 });
    expect(parseRowInput("1", 2)).toEqual({
      ok: false,
      problem: { key: "wsg.lm.belowFloor", params: { floor: "2" } },
    });
    expect(parseRowInput("2.5", 1).ok).toBe(false);
    expect(parseRowInput("", 1).ok).toBe(false);
    expect(parseRowInput("ten", 1).ok).toBe(false);
  });
});

describe("whether the model can call tools", () => {
  it("asks the server with the chat's backend and model", () => {
    expect(toolUseUrl("lmstudio", "qwen/coder 7b")).toBe(
      "/api/models/tool-use?provider=lmstudio&model=qwen%2Fcoder%207b",
    );
  });

  it("reads the answer and refuses anything else", () => {
    expect(parseToolUse({ toolUse: "no", source: "lmstudio" })).toEqual({
      toolUse: "no",
      source: "lmstudio",
    });
    expect(parseToolUse({ toolUse: "maybe", source: "x" })).toBeNull();
    expect(parseToolUse(null)).toBeNull();
  });
});
