// Lifted out of StateGraphView (card 293) when the workflow lens became its
// second consumer. React Flow's own `fitView` prop fires on mount only, so
// without this a re-laid graph kept the old transform and sat small in a
// corner (seen live, not read). A child component because useReactFlow needs
// the provider ReactFlow itself creates.

import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";

/** Re-fits the viewport whenever `laid` — the layout object — changes identity. */
export function RefitOnLayout({ laid }: { laid: unknown }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    void fitView({ padding: 0.1 });
  }, [laid, fitView]);
  return null;
}
