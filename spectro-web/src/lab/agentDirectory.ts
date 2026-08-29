import type { RunEvent } from "../events";

export interface AgentHandle {
  tag: string;
  name: string;
  parentId: string | null;
  title: string | null;
  model?: string;
  firstSeen: number;
}

export type AgentDirectory = ReadonlyMap<string, AgentHandle>;

export const AGENT_RAMP_SLOTS = 5;

export function agentDirectory(_events: readonly RunEvent[], _upto?: number): AgentDirectory {
  return new Map();
}

export function agentTagColor(_tag: string): string {
  return "";
}
