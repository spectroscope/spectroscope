// The export's own chrome words fill their slots the way t() does. Card 440
// found that a string replacement reads $&, $`, $' and $$ in a value as
// patterns; an end reason or a tool name holding one came out changed in the
// exported document.

import { describe, expect, it } from "vitest";
import { label } from "./markup";

describe("label", () => {
  it("fills a slot with the value exactly as written, dollar signs included", () => {
    for (const reason of ["cost $&", "cost $`", "cost $'", "cost $$5", "cost $1"]) {
      expect(label("en", "ended", { reason }), reason).toBe(`ended: ${reason}`);
      expect(label("de", "ended", { reason }), reason).toBe(`beendet: ${reason}`);
    }
  });
});
