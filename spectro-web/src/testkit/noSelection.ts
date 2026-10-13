// Card 593: what a test hands RightPanel when it is not about the agent views:
// no plans, the root of an empty roster shown, and a pick that goes nowhere.
// Test-only: nothing under src/ imports it except *.test.* files.

import { shownAgentOf } from "../state/shownAgent";

export const NO_SELECTION = {
  plans: {},
  shown: shownAgentOf({ rootAgentId: null, agents: [] }, null),
  onPickAgent: (): void => {},
};
