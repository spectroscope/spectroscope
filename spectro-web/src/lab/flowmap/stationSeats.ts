// Where the OS stations sit (card 287). Pure: the seats derive from the width
// set in use — the compact CSS widths or the expanded envelopes — so widening
// a station moves its neighbours instead of overlapping them. The hand-written
// COMMON seats (58/236/462/678 in the 792 band) are exactly this derivation
// over the compact widths, which stationSeats.test.ts proves; the derivation
// replaces the transcription.

const BAND_X = 24; // the z-os zone's own x seat
const FIRST_STATION_X = 58; // the disk's seat, 34 in from the band's edge

export const STATION_GAP = 26;
export const STATION_PAD = FIRST_STATION_X - BAND_X; // 34 — same air on both ends

export function stationSeats(widths: number[], x0: number = FIRST_STATION_X, gap: number = STATION_GAP): number[] {
  const xs: number[] = [];
  let at = x0;
  for (const w of widths) {
    xs.push(at);
    at += w + gap;
  }
  return xs;
}

export function osBandWidth(
  widths: number[],
  x0: number = FIRST_STATION_X,
  gap: number = STATION_GAP,
  pad: number = STATION_PAD,
): number {
  const xs = stationSeats(widths, x0, gap);
  const last = xs.length - 1;
  return xs[last] + widths[last] + pad - BAND_X;
}
