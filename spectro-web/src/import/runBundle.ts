// Card 318: what `GET /api/claude/transcripts/run` answers, read into what
// `importClaudeCodeRun` takes.
//
// There is deliberately no translation here. The server writes the importer's
// own field names — `sessionText`, `sidecars[].jsonlText`, `sidecars[].metaJson`,
// `sidecars[].runId`, `runStates[].runId`, `runStates[].json` — because the
// store door and the folder door must reach ONE merge with one shape. The
// moment a mapping layer sits between them, the two doors can start disagreeing
// about the same session, which is the defect this card exists to end rather
// than to move.
//
// What is left is what any reader of an HTTP body owes: the body is untrusted
// input. A row whose answer is not the expected shape must leave the reader
// with a sentence, not a TypeError thrown inside a promise chain.

import type { RunStateText, SidecarText } from "./claudeCodeRun";

/** The three text sets the coordinator takes, and nothing else. */
export interface RunBundleInput {
  sessionText: string;
  sidecars: SidecarText[];
  runStates: RunStateText[];
}

/** A string field, or undefined when the answer did not carry one. */
function str(from: unknown, key: string): string | undefined {
  const value = (from as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : undefined;
}

/** A number field, or undefined. */
function num(from: unknown, key: string): number | undefined {
  const value = (from as Record<string, unknown> | null)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The bundle as the importer's input.
 *
 * A row missing the text it exists to carry is dropped rather than passed on as
 * an empty one: the coordinator counts an empty sidecar as a SKIPPED child and
 * says so in the banner, and a row the server never sent is not a child anybody
 * skipped.
 *
 * @param body the parsed JSON answer, or anything at all
 * @return the three sets; empty ones for a body that is not the shape, which is
 *         also the honest reading of a session with nothing beside it
 */
export function runBundleInput(body: unknown): RunBundleInput {
  const raw = body as { sidecars?: unknown; runStates?: unknown } | null;
  const sidecars: SidecarText[] = [];
  if (Array.isArray(raw?.sidecars)) {
    for (const row of raw.sidecars) {
      const jsonlText = str(row, "jsonlText");
      if (jsonlText === undefined) continue;
      const runId = str(row, "runId");
      // Spread, not `runId: undefined`: the field is optional and the
      // coordinator reads whether it is THERE. A direct spawn has no run.
      sidecars.push({
        jsonlText,
        metaJson: str(row, "metaJson") ?? "",
        ...(runId === undefined ? {} : { runId }),
      });
    }
  }
  const runStates: RunStateText[] = [];
  if (Array.isArray(raw?.runStates)) {
    for (const row of raw.runStates) {
      const runId = str(row, "runId");
      const json = str(row, "json");
      if (runId === undefined || json === undefined) continue;
      runStates.push({ runId, json });
    }
  }
  return { sessionText: str(body, "sessionText") ?? "", sidecars, runStates };
}

/** What a 413 said the run weighed, and what this server carries. */
export interface RunRefusal {
  totalBytes: number;
  limitBytes: number;
}

/**
 * The refusal's two numbers, or null.
 *
 * Both or neither. The row's degrade sentence prints the pair — how big the run
 * was, how much the server carries — and half of it would read worse than the
 * bare status it replaced, so an answer that cannot say both says nothing here
 * and the caller falls back to the ordinary fetch error.
 *
 * @param body the parsed JSON of the 413 answer
 * @return the numbers, or null
 */
export function runRefusal(body: unknown): RunRefusal | null {
  const totalBytes = num(body, "totalBytes");
  const limitBytes = num(body, "limitBytes");
  return totalBytes === undefined || limitBytes === undefined ? null : { totalBytes, limitBytes };
}
