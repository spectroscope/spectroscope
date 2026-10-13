// Card 586: a workflow run's steps as a chain, in the wide run view.
//
// A workflow run has no graph file; its forward path is a list of steps. The
// chain draws one link per step with its status mark and name, in order. A
// press on a link selects that step, and the wide view shows its latest entry.
// Styles: styles/run-panel.css.

import { useLang } from "../state/lang";
import { nodeStatuses, type RunTrack } from "../state/runView";
import { statusMark, statusWord } from "./runPanelModel";

export interface RunChainProps {
  run: RunTrack;
  /** The selected node's id, or null. */
  selected: string | null;
  onSelect: (node: string) => void;
}

export function RunChain({ run, selected, onSelect }: RunChainProps): React.JSX.Element {
  const lang = useLang();
  const statuses = nodeStatuses(run);
  return (
    <ol className="run-chain">
      {run.nodes.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            className={`run-link run-link--${statuses[n.id]}`}
            data-node={n.id}
            aria-pressed={selected === n.id}
            title={`${n.name}: ${statusWord(lang, statuses[n.id])}`}
            onClick={() => onSelect(n.id)}
          >
            <span className="run-mark">{statusMark(statuses[n.id], n.kind === "decision")}</span>{" "}
            <span className="run-link-name">{n.name}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
