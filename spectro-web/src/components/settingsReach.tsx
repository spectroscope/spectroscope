// WHEN a saved setting lands — the one place the settings page is allowed to
// say it, and the table it has to say it from.
//
// Card 222 is the bill for a page that reported a state the run did not have:
// the owner saved a SearXNG address, the page drew the new tier, and the next
// search in the same window used the old one. The first fix made the belt live
// and put a sentence on the page — "Applies immediately, including to a session
// already open" — directly under a grid of SEVEN fields of which one was. The
// review measured it: settings written to model=qwen3:latest, /api/config
// agreed, and the next run in the same session still started on the old model.
// The card's own defect, one block higher and in larger type.
//
// So the sentence is not free text any more. A block declares WHICH settings it
// covers; the sentence is derived from this table; and a block whose fields do
// not all land at the same moment cannot render a sentence at all. The fields
// are typed against the table, so a setting nobody has classified is a
// compile error in `tsc -b` rather than an unnoticed promise — and the guard
// beside this file walks the page's source to check that every field sits under
// the block that names it.

import type { ReactNode } from "react";
import { t, type Lang } from "../i18n/i18n";

/** The two answers a settings field can give to "when does this take effect?".
 *  There is no third: "it depends" is what the page used to say by saying
 *  nothing. */
export type Reach = "live" | "next-session";

/**
 * Every saveable setting on the page, and when it reaches a session that is
 * already open. Measured against the code that reads it, not against intent:
 *
 * - `live` — a tool or a controller reads the settings again when it acts, so
 *   a save decides the next tool call (the belt: `SessionConnection.liveConfig`)
 *   or the next request (`logLevel` on PUT, `sttModel` per transcription).
 * - `next-session` — the value is bound when the agent is built, or the change
 *   would mean killing processes or rewriting a conversation that has already
 *   happened. The allowlist is the one entry that is next-session BY CHOICE:
 *   the agent can write files in its own workspace, so a live allowlist would
 *   let a run widen its own permissions between two tool calls.
 */
export const SETTING_REACH = {
  // ---- session defaults: bound when the agent is built ----
  provider: "next-session",
  model: "next-session",
  ollamaBaseUrl: "next-session",
  lmstudioBaseUrl: "next-session",
  // `.thinking(thinking.get())` is read once, at the build. The header toggle
  // forwards to the live agent (Agent#setThinking); a settings write does not.
  thinking: "next-session",
  // ---- the belt reads these again on every call ----
  imageProvider: "live",
  imageModel: "live",
  searxngUrl: "live",
  allowLocalhost: "live",
  chromeBinary: "live",
  // TranscribeController loads the config per request, so dictation picks a
  // saved model up without a new session.
  sttModel: "live",
  // SettingsController applies this to the running process on PUT.
  logLevel: "live",
  // ---- settled for the session ----
  workspace: "next-session",
  autoApprove: "next-session",
  hooks: "next-session",
  // The exporter is built where the session store is minted.
  otlpEndpoint: "next-session",
  otlpBasicAuth: "next-session",
} as const satisfies Record<string, Reach>;

/** A settings key this page knows how to be honest about. A new field has to
 *  join {@link SETTING_REACH} before it can be put inside a block, which is the
 *  compile-time half of the guard. */
export type SettingKey = keyof typeof SETTING_REACH;

/**
 * The sentences that may end a block, and what each one promises. A block whose
 * fields disagree with its sentence falls back to the generic one for its own
 * reach — the page can be terse, it cannot be wrong.
 */
export const NOTE_REACH: Record<string, Reach> = {
  "set.reachLive": "live",
  "set.reachNextSession": "next-session",
  // Block-specific wordings that carry their own reason. They still have to
  // agree with the table above.
  "set.provApplies": "next-session",
  "set.hkApplies": "next-session",
  "set.alApplies": "next-session",
  "set.wsApplies": "next-session",
  "set.logApplies": "live",
};

/** The generic sentence for a reach, when a block does not bring its own. */
const GENERIC: Record<Reach, string> = {
  live: "set.reachLive",
  "next-session": "set.reachNextSession",
};

/**
 * When this set of settings lands.
 *
 * @param fields the settings one sentence is about to cover
 * @returns the reach they share
 * @throws Error when they do not share one — which is precisely the defect this
 *         module exists for. A sentence covering a live field and a
 *         session-fixed one is true of half the grid it sits under.
 */
export function reachOf(fields: readonly SettingKey[]): Reach {
  if (fields.length === 0) {
    throw new Error("a reach block has to name the settings it speaks for");
  }
  const reaches = fields.map((field) => SETTING_REACH[field]);
  const first = reaches[0] as Reach;
  if (reaches.some((reach) => reach !== first)) {
    throw new Error(
      `one sentence cannot cover ${fields.join(", ")} — they do not all reach a session ` +
        `that is already open, and a note that is true of half a grid is what card 222 is about`,
    );
  }
  return first;
}

/**
 * The i18n key a block should render.
 *
 * @param fields the settings the block covers
 * @param note   a block-specific sentence, when the generic one would leave out
 *               a reason the reader needs
 * @returns the custom key when it agrees with the table, the generic one otherwise
 */
export function noteKeyFor(fields: readonly SettingKey[], note?: string): string {
  const reach = reachOf(fields);
  if (note && NOTE_REACH[note] === reach) {
    return note;
  }
  return GENERIC[reach];
}

/**
 * A settings block that says when its own fields land.
 *
 * <p>The sentence goes after the controls, deliberately: it is the answer to
 * "what happens when I change this", and that question is asked with the
 * control already in view.</p>
 *
 * @param props.lang     the UI language
 * @param props.fields   the settings this block covers — typed, so an
 *                       unclassified one does not compile
 * @param props.note     an optional block-specific sentence key
 * @param props.children the controls themselves
 */
export function ReachBlock({
  lang,
  fields,
  note,
  children,
}: {
  lang: Lang;
  fields: readonly SettingKey[];
  note?: string;
  children?: ReactNode;
}) {
  const reach = reachOf(fields);
  return (
    <>
      {children}
      <p className="settings-note" data-reach={reach} data-reach-fields={fields.join(" ")}>
        {t(lang, noteKeyFor(fields, note))}
      </p>
    </>
  );
}
