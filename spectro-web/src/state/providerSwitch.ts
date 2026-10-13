// The model picker's switch and the default for new chats (card 459, card 556).
//
// A switch is not optimistic: the server answers set_provider with a
// provider_info frame, and only that answer writes the picked pair as the
// default for new chats. This module says which frame that answer is.
//
// Every pick carries an ask id, and the provider_info that answers it echoes
// the id as `answers` (SessionConnection.onSetProvider). Nothing else counts:
// a record that opens for a stored session announces the pair its history
// names at connect or at the wake, with no id, and a refused switch answers
// with an error and no provider_info at all.
//
// A live session asks on the record in view (card 459). A stored session asks
// before any record holds it: the pick continues the session, on the socket
// its wake holds or on a resume socket (App's sessionFrame), so its answer is
// read on a record of that session.

import type { ClientMessage, RunEvent } from "../events";
import type { UiState } from "./reducer";

/** A switch the picker sent, waiting for the server's answer. */
export interface AskedSwitch {
  /** The live record that asked, or null when a stored session asked. */
  readonly key: string | null;
  /** The stored session that asked, or null when a live record asked. */
  readonly sessionId: string | null;
  readonly provider: string;
  /** The model asked for; empty lets the server pick the provider's default. */
  readonly model: string;
  /** The id the server's answer echoes. */
  readonly ask: string;
}

/** The record a batch arrived on. */
export interface BatchSource {
  readonly key: string;
  /** The session that record holds, or null for a record without one yet. */
  readonly sessionId: string | null;
}

/** A pair the server confirmed, in the shape the user settings take it. */
export type ConfirmedPair = {
  readonly provider: string;
  readonly model: string;
};

let asks = 0;

/** A fresh ask id for this page. */
export function nextSwitchAsk(): string {
  asks += 1;
  return `pick-${asks}`;
}

/**
 * Who asks for a switch.
 *
 * @param storedId the stored session on screen, or null in the live view
 * @param viewKey  the record in view
 * @param provider the provider picked
 * @param model    the model picked, empty for the provider's default
 * @param ask      the id the answer will echo
 * @returns the switch to wait for
 */
export function askedSwitch(
  storedId: string | null,
  viewKey: string,
  provider: string,
  model: string,
  ask: string,
): AskedSwitch {
  return storedId === null
    ? { key: viewKey, sessionId: null, provider, model, ask }
    : { key: null, sessionId: storedId, provider, model, ask };
}

/**
 * The set_provider frame of a pick.
 *
 * @param asked the pick
 * @returns the frame, with a model only when one was picked
 */
export function switchFrame(asked: AskedSwitch): ClientMessage {
  return {
    type: "set_provider",
    provider: asked.provider,
    ...(asked.model !== "" ? { model: asked.model } : {}),
    ask: asked.ask,
  };
}

/**
 * The pair a batch confirms for the switch that asked: the server's answer to
 * this pick, naming the provider picked and the model picked. A pick with no
 * model takes the model the server named in that answer.
 *
 * @param asked the switch waiting, or null
 * @param from  the record the batch arrived on
 * @param batch the frames of that batch
 * @returns the confirmed pair, or null when this batch confirms nothing
 */
export function confirmedSwitch(
  asked: AskedSwitch | null,
  from: BatchSource,
  batch: readonly RunEvent[],
): ConfirmedPair | null {
  if (asked === null) return null;
  const mine =
    asked.key !== null
      ? from.key === asked.key
      : from.sessionId !== null && from.sessionId === asked.sessionId;
  if (!mine) return null;
  const answer = batch.find((e) => {
    const frame = e as { type?: string; answers?: unknown };
    return frame.type === "provider_info" && frame.answers === asked.ask;
  }) as { provider?: unknown; model?: unknown } | undefined;
  if (answer === undefined || answer.provider !== asked.provider) return null;
  const model = typeof answer.model === "string" ? answer.model : "";
  if (asked.model !== "" && model !== asked.model) return null;
  return { provider: asked.provider, model };
}

/**
 * Whether the frames a resume dropped carry the pick that waits (card 556):
 * the resume ended without continuing the session, so no answer will come.
 *
 * @param asked     the switch waiting, or null
 * @param sessionId the stored session the resume was for
 * @param frames    the frames it dropped
 * @returns true when the pick went with them
 */
export function switchLost(
  asked: AskedSwitch | null,
  sessionId: string,
  frames: readonly ClientMessage[],
): boolean {
  if (asked === null || asked.sessionId !== sessionId) return false;
  return frames.some((frame) => frame.type === "set_provider" && frame.ask === asked.ask);
}

/**
 * The chat line a stored session shows when a pick did not reach it: a warning
 * in the live chrome language, as the other client-side refusals are drawn.
 *
 * @param state the stored session's folded state
 * @param asked the pick that did not arrive
 * @returns the state with the line at its end
 */
export function switchNotSent(state: UiState, asked: AskedSwitch): UiState {
  const pair = asked.model !== "" ? `${asked.provider} ${asked.model}` : asked.provider;
  return {
    ...state,
    turns: [
      ...state.turns,
      {
        kind: "info",
        text: `The switch to ${pair} did not reach this session: it could not be opened. Nothing changed.`,
        tone: "warn",
        infoKey: "chat.switchNotSent",
        infoVars: { pair },
      },
    ],
  };
}
