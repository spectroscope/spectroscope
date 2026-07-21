// sceneNow — a short, bilingual "what is happening right now" line derived from a
// folded Scene. The Lab's floating "now" band names the current station with it,
// so a scrubbed replay always says where the run is. Pure, no DOM.

import type { Scene } from "./labScene";

export function sceneNow(scene: Scene): { en: string; de: string } {
  if (scene.gate === "pending") return { en: "the permission gate is deciding", de: "das permission-gate entscheidet" };
  const file = scene.activeFile ? ` ${scene.activeFile}` : "";
  switch (scene.focus) {
    case "llm":
      return { en: "the model is thinking", de: "das modell denkt" };
    case "disk":
      return scene.disk === "write"
        ? { en: `writing${file} to disk`, de: `schreibt${file} auf die disk` }
        : { en: `reading${file} from disk`, de: `liest${file} von der disk` };
    case "cmd":
      return { en: `running: ${scene.activeCommand ?? "a command"}`, de: `führt aus: ${scene.activeCommand ?? "einen befehl"}` };
    case "mcp":
      return { en: `calling mcp${scene.activeMcp ? `: ${scene.activeMcp}` : ""}`, de: `mcp-aufruf${scene.activeMcp ? `: ${scene.activeMcp}` : ""}` };
    case "gate":
      return { en: "at the permission gate", de: "am permission-gate" };
    case "user":
      return { en: "done · control is with you", de: "fertig · die kontrolle ist bei dir" };
    case "agent":
    default:
      return scene.subagents.length
        ? { en: `orchestrating ${scene.subagents.length} workers`, de: `orchestriert ${scene.subagents.length} worker` }
        : { en: "the harness is working", de: "der harness arbeitet" };
  }
}
