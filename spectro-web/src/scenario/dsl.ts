// The bilingual scenario DSL, ported from the LLM_Simulator. A scenario is
// authored ONCE with every text either a plain string or { en, de }; the
// compiler resolves one language at load time. The pairing lives ONLY here —
// compiled events are single-language and byte-identical wire format.

import type { Lang } from "../i18n/i18n";

export type { Lang };
export type Localized = string | { en: string; de: string };
export type Gate = "allow" | "deny";

export type Step =
  | { think: Localized }
  | { say: Localized }
  | { read: string; result?: Localized }
  | { write: string; result?: Localized }
  | { list: string; result?: Localized }
  | { run: string; gate?: Gate; result?: Localized; error?: boolean }
  | { mcp: string; input?: Record<string, unknown>; gate?: Gate; result?: Localized; error?: boolean }
  | { tool: string; input?: Record<string, unknown>; gate?: Gate; result?: Localized; error?: boolean }
  | { status: Localized }
  | { usage: { in: number; out: number } }
  | { context: { parts: { label: Localized; chars: number; estTokens: number }[] } }
  | { compact: { removedTurns: number; summaryChars: number } }
  | {
      image: Localized;
      provider?: string;
      model?: string;
      /** A bundled demo asset path (e.g. /demo/beach-cat.jpg) served by the app
       *  itself — the UI then renders the REAL image instead of the placeholder. */
      asset?: string;
    }
  | { spawn: string; label?: string; task: Localized; steps: Step[] }
  | { fanout: { label?: string; tool: string; agents: { id: string; task: Localized; steps: Step[] }[] } };

/** Card 302: a workflow-shaped scenario DECLARES its columns, the way a real
 *  run's state file does — before a single event is compiled. Titles are
 *  localized like every other text; `agents` names the ids this phase's
 *  fan-out spawns, which is what lets the lens rank by the declaration
 *  instead of guessing waves off the stamps. */
export interface DslPhase {
  title: Localized;
  detail?: Localized;
  agents: string[];
}

export interface Dsl {
  id: string;
  name: Localized;
  prompt: Localized;
  provider?: string;
  system?: Localized;
  steps: Step[];
  /** A multi-agent scenario that reads best as a FLEET (a topology of parallel
   *  agents), not a single chat run. The picker lists these under the "fleet"
   *  tab and loads them into the fleet canvas instead of the Lab stepper. */
  fleet?: boolean;
  /** The declared phases, when this scenario is a workflow. Absent for every
   *  other scenario, which then draws the recovered picture and says so. */
  phases?: DslPhase[];
}

export function loc(v: Localized, lang: Lang): string {
  if (typeof v === "string") return v;
  return v[lang] ?? v.en ?? v.de ?? "";
}
