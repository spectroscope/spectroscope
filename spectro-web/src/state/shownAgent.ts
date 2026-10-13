// Card 593: which agent the agent views show, one choice per record in view.
//
// The choice is not part of UiState: UiState is folded from wire events only,
// and a stored session on screen swaps in replay.state outside the
// SessionSet. A store keyed by the view key serves both and resets on a
// session switch, because the key changes. Nothing is persisted; a reload
// starts at the root.

import { useSyncExternalStore } from "react";
import { TITLE_AGENT_ID } from "../events";
import type { AgentInfo, HelperFigures, UiState } from "./reducer";

/** The agent the views show, resolved against the roster. */
export interface ShownAgent {
  /** The agent whose figures the views show. */
  id: string;
  /** The root of the session, shown by default. */
  rootId: string;
  isRoot: boolean;
  /** The roster row of `id`, or null before the roster has it. */
  row: AgentInfo | null;
  /** A choice that is not in the roster; the views then show the root and say so. */
  missing: string | null;
}

/** What a picker needs: the roster, the shown agent and the pick. */
export interface AgentPick {
  agents: readonly AgentInfo[];
  shown: ShownAgent;
  /** null picks the root. */
  onPick: (id: string | null) => void;
}

/** What the ring shows: its picker and the shown agent's figures. */
export interface RingView {
  picker: AgentPick;
  figures: HelperFigures;
}

const choices = new Map<string, string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The chosen agent id of a view, or null for the root. */
export function useShownAgent(viewKey: string): string | null {
  const get = (): string | null => choices.get(viewKey) ?? null;
  return useSyncExternalStore(subscribe, get, get);
}

/** @param id the helper to show, or null for the root */
export function setShownAgent(viewKey: string, id: string | null): void {
  if (id === null) choices.delete(viewKey);
  else choices.set(viewKey, id);
  notify();
}

export function forgetShownAgent(viewKey: string): void {
  if (choices.delete(viewKey)) notify();
}

/** The view keys that were live before and are gone now: their records closed, so their choices go. */
export function closedViewKeys(before: readonly string[], now: readonly string[]): string[] {
  return before.filter((key) => !now.includes(key));
}

/** Test-only. */
export function __resetShownAgentForTests(): void {
  choices.clear();
  notify();
}

/** The root of a session: the root run's agent, else the first roster row
 *  without a parent that is not the session-title call, else "main". */
export function rootAgentIdOf(state: Pick<UiState, "rootAgentId" | "agents">): string {
  if (state.rootAgentId !== null) return state.rootAgentId;
  const first = state.agents.find((a) => a.parentId === null && a.id !== TITLE_AGENT_ID);
  return first?.id ?? "main";
}

/** Resolves a choice against the roster. A choice that names no helper of the session shows the root and names what is gone. */
export function shownAgentOf(
  state: Pick<UiState, "rootAgentId" | "agents">,
  choice: string | null,
): ShownAgent {
  const rootId = rootAgentIdOf(state);
  const rootRow = state.agents.find((a) => a.id === rootId) ?? null;
  if (choice === null || choice === rootId)
    return { id: rootId, rootId, isRoot: true, row: rootRow, missing: null };
  const row = state.agents.find((a) => a.id === choice && a.parentId !== null) ?? null;
  if (row === null) return { id: rootId, rootId, isRoot: true, row: rootRow, missing: choice };
  return { id: choice, rootId, isRoot: false, row, missing: null };
}

/** The ring's figures for the shown agent: the root's three fields, or the helper's slot, zeros before its first frame. */
export function figuresOf(
  state: Pick<UiState, "lastInputTokens" | "context" | "announcedWindow" | "helpers">,
  shown: ShownAgent,
): HelperFigures {
  if (shown.isRoot) {
    return {
      lastInputTokens: state.lastInputTokens,
      context: state.context,
      announcedWindow: state.announcedWindow,
    };
  }
  return state.helpers[shown.id] ?? { lastInputTokens: 0, context: null, announcedWindow: null };
}

/** What the ring shows for this view, or undefined where App handed no selection (the Lab's chat). */
export function ringOf(
  meta: { shown?: ShownAgent; onPickAgent?: (id: string | null) => void } | undefined,
  state: Pick<UiState, "agents" | "lastInputTokens" | "context" | "announcedWindow" | "helpers">,
): RingView | undefined {
  if (meta?.shown === undefined || meta.onPickAgent === undefined) return undefined;
  return {
    picker: { agents: state.agents, shown: meta.shown, onPick: meta.onPickAgent },
    figures: figuresOf(state, meta.shown),
  };
}
