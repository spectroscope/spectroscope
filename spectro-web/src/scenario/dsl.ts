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
  | { spawn: string; label?: string; task: Localized; steps: Step[] }
  | { fanout: { label?: string; tool: string; agents: { id: string; task: Localized; steps: Step[] }[] } };

export interface Dsl {
  id: string;
  name: Localized;
  prompt: Localized;
  provider?: string;
  system?: Localized;
  steps: Step[];
}

export function loc(v: Localized, lang: Lang): string {
  if (typeof v === "string") return v;
  return v[lang] ?? v.en ?? v.de ?? "";
}
