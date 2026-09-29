// The gear, one glyph for every settings door (card 442): the composer's gear
// and the settings entry at the foot of the sidebar.
//
// Card 383: a 16 unit box at 16px, so a viewBox unit is one CSS pixel. Lucide
// draws its gear on a 24 unit grid; this is that gear with every coordinate
// multiplied by 2/3 and rounded to four decimals. The largest departure from an
// exact scale is 0.000033px.

/** The cog's outline in a 16 unit box. */
export const GEAR_PATH =
  "M12.9333 10 a1.1 1.1 0 0 0 0.22 1.2133 l0.04 0.04 a1.3333 1.3333 0 0 1 0 1.8867 1.3333 1.3333 0 0 1 -1.8867 0 l-0.04 -0.04 a1.1 1.1 0 0 0 -1.2133 -0.22 1.1 1.1 0 0 0 -0.6667 1.0067 V14 a1.3333 1.3333 0 0 1 -1.3333 1.3333 1.3333 1.3333 0 0 1 -1.3333 -1.3333 v-0.06 A1.1 1.1 0 0 0 6 12.9333 a1.1 1.1 0 0 0 -1.2133 0.22 l-0.04 0.04 a1.3333 1.3333 0 0 1 -1.8867 0 1.3333 1.3333 0 0 1 0 -1.8867 l0.04 -0.04 a1.1 1.1 0 0 0 0.22 -1.2133 1.1 1.1 0 0 0 -1.0067 -0.6667 H2 a1.3333 1.3333 0 0 1 -1.3333 -1.3333 1.3333 1.3333 0 0 1 1.3333 -1.3333 h0.06 A1.1 1.1 0 0 0 3.0667 6 a1.1 1.1 0 0 0 -0.22 -1.2133 l-0.04 -0.04 a1.3333 1.3333 0 0 1 0 -1.8867 1.3333 1.3333 0 0 1 1.8867 0 l0.04 0.04 a1.1 1.1 0 0 0 1.2133 0.22 H6 a1.1 1.1 0 0 0 0.6667 -1.0067 V2 a1.3333 1.3333 0 0 1 1.3333 -1.3333 1.3333 1.3333 0 0 1 1.3333 1.3333 v0.06 a1.1 1.1 0 0 0 0.6667 1.0067 1.1 1.1 0 0 0 1.2133 -0.22 l0.04 -0.04 a1.3333 1.3333 0 0 1 1.8867 0 1.3333 1.3333 0 0 1 0 1.8867 l-0.04 0.04 a1.1 1.1 0 0 0 -0.22 1.2133 V6 a1.1 1.1 0 0 0 1.0067 0.6667 H14 a1.3333 1.3333 0 0 1 1.3333 1.3333 1.3333 1.3333 0 0 1 -1.3333 1.3333 h-0.06 a1.1 1.1 0 0 0 -1.0067 0.6667 z";

/** The gear's shapes, for an svg with a 16 unit viewBox that sets the stroke. */
export function GearGlyph() {
  return (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d={GEAR_PATH} />
    </>
  );
}
