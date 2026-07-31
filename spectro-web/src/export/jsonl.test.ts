// The claim under test is a byte claim, so the fixtures are real bytes: sixteen
// lines lifted verbatim out of ~/.spectro/sessions, written by the Java
// SessionStore (Jackson), covering every event type those sessions contain —
// umlauts, an ellipsis, escaped quotes, embedded newlines, nested arrays and
// the optional cache-token fields. If toJsonl ever stops reproducing these
// character for character, a translated export stops being loadable by the
// Java side and by the Python edition, and this suite says so.

import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { detectAndLoad } from "../import/detect";
import { initialState, reduceAll } from "../state/reducer";
import { __resetForTests, __setTestHooks, downloadJsonl, jsonlFilename, toJsonl } from "./jsonl";

/** Verbatim lines from stored sessions — String.raw keeps their escapes intact. */
const STORED_LINES: string[] = [
  String.raw`{"type":"run_start","runId":"1b1d1774-4c32-40dc-8e7f-4ac7d5ca4e32","agentId":"main","prompt":"Liste das aktuelle Verzeichnis auf, lies dann pi.py (falls vorhanden, sonst irgendeine .py), und führe danach \"echo hallo\" aus.","provider":"anthropic","model":"claude-opus-4-8","ts":1785016331714}`,
  String.raw`{"type":"turn_start","agentId":"worker-correctness","turn":1,"ts":1783050004070}`,
  String.raw`{"type":"context_info","agentId":"main","turn":2,"messages":3,"estimatedTokens":4667,"threshold":100000,"parts":[{"label":"system prompt","chars":1035,"estTokens":258},{"label":"tool schemas","chars":7272,"estTokens":1818},{"label":"conversation","chars":10367,"estTokens":2591}],"ts":1784292269975}`,
  String.raw`{"type":"thinking_delta","agentId":"main","text":" back at the conversation, their only message was \"miau\" — so that","ts":1784999683841}`,
  String.raw`{"type":"tool_call","agentId":"main","callId":"toolu_0123XM6WB7buLqmh76WdsGq2","name":"write_file","input":{"path":"pi.py","content":"import math\n\n\ndef pi_auf_3_stellen():\n    \"\"\"Berechnet Pi und rundet auf 3 Nachkommastellen.\"\"\"\n    return round(math.pi, 3)\n\n\nif __name__ == \"__main__\":\n    print(f\"Pi auf 3 Nachkommastellen: {pi_auf_3_stellen()}\")\n"},"ts":1784882637542}`,
  String.raw`{"type":"usage","agentId":"main","inputTokens":2549,"outputTokens":852,"cacheReadTokens":11628,"cacheCreationTokens":143,"ts":1785015154386}`,
  String.raw`{"type":"tool_result","agentId":"conductor","callId":"c1","output":"--- Subagent 1 ---\n…\n--- Subagent 2 ---\n…\n--- Subagent 3 ---\n…","isError":false,"durationMs":0,"ts":1783050026190}`,
  String.raw`{"type":"plan","agentId":"main","steps":[{"text":"Write passgen.py with --length and --symbols flags","status":"completed"},{"text":"Run it twice with different flags","status":"in_progress"},{"text":"Show both outputs","status":"pending"}],"ts":1784291663049}`,
  String.raw`{"type":"permission_decision","callId":"toolu_01BH7SwoPePATvYgg2yChuQx","allowed":false,"ts":1784830899636}`,
  String.raw`{"type":"permission_request","agentId":"main","callId":"toolu_01Haqb7sYPAE84QYQZJ2oDc5","name":"run_command","input":{"command":"echo \"=== Leibniz ===\" && python3 pi_leibniz.py && echo \"\" && echo \"=== Monte Carlo ===\" && python3 pi_montecarlo.py --seed 42 && echo \"\" && echo \"=== Nilakantha ===\" && python3 pi_nilakantha.py"},"ts":1785015094787}`,
  String.raw`{"type":"text_delta","agentId":"worker-1","text":" prevent theme flicker\n5. **Testing & Deployment** – Write unit tests, complete QA checklist across browsers, and deploy with monitoring\n\n### Key Features","ts":1784292491403}`,
  String.raw`{"type":"run_end","runId":"76f4cf6e-d838-412b-95f1-ad7886699a8c","stopReason":"end_turn","ts":1784291673071}`,
  String.raw`{"type":"agent_message","from":"worker-security","to":"conductor","role":"result","state":"completed","text":"[worker-security] result (tokens: 420 in / 55 out):\nSession id rotates on login — fixation closed.","ts":1783050009036}`,
  String.raw`{"type":"image_generated","agentId":"main","callId":"ollama-call-570283212650000","prompt":"a cute cat","provider":"openai","model":"gpt-image-1","mediaType":"image/png","blobPath":"images/50e60049a3e19eb756be768479d3229e0f8747990d18efc7d5c53585c6d67bf5.png","sha256":"50e60049a3e19eb756be768479d3229e0f8747990d18efc7d5c53585c6d67bf5","ts":1784550018429}`,
  String.raw`{"type":"error","agentId":"node-2c22199b","message":"I/O error on POST request for \"http://localhost:1234/v1/chat/completions\": null","ts":1784679396491}`,
  String.raw`{"type":"agent_spawn","agentId":"worker-correctness","parentId":"conductor","task":"check correctness of the token refresh","ts":1783050003790}`,
];

/** The session file as the store wrote it: every line, trailing newline. */
const STORED_FILE = `${STORED_LINES.join("\n")}\n`;

const storedEvents = (): RunEvent[] => STORED_LINES.map((l) => JSON.parse(l) as RunEvent);

describe("toJsonl", () => {
  it("reproduces a stored session file byte for byte", () => {
    expect(toJsonl(storedEvents())).toBe(STORED_FILE);
  });

  it("writes one line per event and closes the last one", () => {
    const out = toJsonl(storedEvents());
    expect(out.endsWith("\n")).toBe(true);
    expect(out.split("\n").filter((l) => l !== "").length).toBe(STORED_LINES.length);
  });

  it("keeps a multi-line tool call on ONE line", () => {
    // The write_file fixture carries a whole Python file in its input; a raw
    // newline escaping into the output would split one event into six.
    const call = storedEvents().filter((e) => e.type === "tool_call");
    expect(toJsonl(call).split("\n").filter(Boolean).length).toBe(1);
  });

  it("writes an empty file for no events, not a blank line", () => {
    expect(toJsonl([])).toBe("");
  });

  it("refuses a non-finite number instead of silently writing null", () => {
    // JSON.stringify turns NaN into null, which the Java reader would take as a
    // real timestamp of zero. A loud failure beats a corrupt session file.
    const broken = [{ type: "turn_start", agentId: "main", turn: 1, ts: NaN }] as unknown as RunEvent[];
    expect(() => toJsonl(broken)).toThrow(/ts/);
  });

  it("changes only the translated bytes when a field is replaced", () => {
    // A translated stream is the same events with new strings in place. Because
    // the spread keeps key order, the file stays a line-by-line diff of the
    // original — which is what makes a translated export reviewable.
    const events = storedEvents();
    const translated = events.map((e) =>
      e.type === "text_delta" ? { ...e, text: "Design-Flackern verhindern" } : e,
    );
    const before = toJsonl(events).split("\n");
    const after = toJsonl(translated).split("\n");
    const differing = before.filter((line, i) => line !== after[i]);
    expect(differing.length).toBe(1);
    expect(after[10]).toContain('"text":"Design-Flackern verhindern"');
  });
});

describe("round trip", () => {
  it("re-imports through detectAndLoad as a spectroscope session", () => {
    const { kind, events } = detectAndLoad(toJsonl(storedEvents()));
    expect(kind).toBe("spectroscope");
    expect(events).toEqual(storedEvents());
  });

  it("folds to the same state as the events it was written from", () => {
    const original = storedEvents();
    const reloaded = detectAndLoad(toJsonl(original)).events;
    expect(reduceAll(initialState, reloaded)).toEqual(reduceAll(initialState, original));
  });

  it("survives a second lap, so an exported file can be exported again", () => {
    const once = toJsonl(storedEvents());
    expect(toJsonl(detectAndLoad(once).events)).toBe(once);
  });
});

describe("jsonlFilename", () => {
  const at = new Date(2026, 6, 27, 9, 5, 3);

  it("names the language so a folder of exports is readable", () => {
    expect(jsonlFilename({ base: "20260727-090503-ab12cd34", lang: "de", at })).toBe(
      "20260727-090503-ab12cd34.translated-de.jsonl",
    );
  });

  it("drops the translation tag when nothing was translated", () => {
    expect(jsonlFilename({ base: "20260727-090503-ab12cd34", at })).toBe("20260727-090503-ab12cd34.jsonl");
  });

  it("claims no language when the target is blank", () => {
    // Honest naming: "translated" we know, "into what" we do not.
    expect(jsonlFilename({ base: "s1", lang: "  ", at })).toBe("s1.translated.jsonl");
  });

  it("falls back to a wall-clock stamp when there is no session id", () => {
    expect(jsonlFilename({ lang: "uk", at })).toBe(
      "spectroscope-session-20260727-090503.translated-uk.jsonl",
    );
    expect(jsonlFilename({ base: "   ", lang: "uk", at })).toBe(
      "spectroscope-session-20260727-090503.translated-uk.jsonl",
    );
  });

  it("strips a .jsonl the caller already carried in", () => {
    expect(jsonlFilename({ base: "incident.jsonl", lang: "en", at })).toBe("incident.translated-en.jsonl");
  });

  it("keeps an imported file's name from steering the save dialog", () => {
    // The base can be the name of a file someone else wrote.
    expect(jsonlFilename({ base: "../../etc/passwd", lang: "de", at })).toBe(
      "etc-passwd.translated-de.jsonl",
    );
    expect(jsonlFilename({ base: 'a b"c\nd', lang: "de", at })).toBe("a-b-c-d.translated-de.jsonl");
    expect(jsonlFilename({ base: "x".repeat(200), lang: "de", at }).length).toBeLessThan(100);
  });

  it("normalizes the language tag it prints", () => {
    expect(jsonlFilename({ base: "s1", lang: "DE", at })).toBe("s1.translated-de.jsonl");
    expect(jsonlFilename({ base: "s1", lang: "pt-BR", at })).toBe("s1.translated-pt-br.jsonl");
    expect(jsonlFilename({ base: "s1", lang: "../de", at })).toBe("s1.translated-de.jsonl");
  });
});

describe("downloadJsonl", () => {
  let saved: { text: string; filename: string }[] = [];

  beforeEach(() => {
    saved = [];
    __setTestHooks({ save: (text, filename) => saved.push({ text, filename }) });
  });

  it("hands the save exactly the bytes toJsonl produced", () => {
    const written = downloadJsonl(storedEvents(), "s1.translated-de.jsonl");
    expect(written).toBe(STORED_LINES.length);
    expect(saved).toEqual([{ text: STORED_FILE, filename: "s1.translated-de.jsonl" }]);
  });

  it("resets to the browser saver", () => {
    __resetForTests();
    // No DOM in this suite, so the real saver must be the thing that fails here.
    expect(() => downloadJsonl(storedEvents(), "s1.jsonl")).toThrow();
  });
});
