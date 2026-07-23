// When true, the cards render with their disclosures OPEN by default (the full
// instrument at a glance). The simulator leaves it false (a card starts compact);
// edu provides `true` so a lesson shows the system context, the reasoning, and a
// subagent's task + history inline, without a click.

import { createContext } from "react";

export const ExpandAllContext = createContext(false);
