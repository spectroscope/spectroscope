// The live obstacle set for the rails (card 287): every card's box, recomputed
// from the rendered nodes so a dragged card re-routes its rails. Zones are
// excluded — they are the drawn frames, not cards. A canvas that provides no
// boxes (the fleet machine room, tests) gets the helper's own default trunk.
import { createContext } from "react";
import type { RailBox } from "./railRoute";

export const RailBoxes = createContext<ReadonlyArray<RailBox>>([]);
