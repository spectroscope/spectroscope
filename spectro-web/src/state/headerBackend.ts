// Release 0.14.2, live check D1: the header chip names one provider and model
// pair, taken from one source. A stored session read from its record names
// the pair it ran on. A live session names the server's provider_info frame
// once it has arrived, before that the pair its history recorded (a continued
// session), and last the boot config (a fresh chat).

/** A provider and model as a source knows them; either may be missing. */
export interface BackendPair {
  provider: string | null;
  model: string | null;
}

/** What the header chip shows. */
export interface ChipPair {
  provider: string | undefined;
  model: string | undefined;
}

/**
 * The pair the header chip names.
 *
 * @param viewingLive whether the view is a live session rather than a record
 * @param recorded the provider and model of the viewed state's last main run
 * @param wire the in-view socket's provider_info, or null before it arrives
 * @param boot the server's boot config (/api/config), or null before it loads
 */
export function headerBackend(input: {
  viewingLive: boolean;
  recorded: BackendPair;
  wire: { provider: string; model: string } | null | undefined;
  boot: { provider: string; model: string } | null | undefined;
}): ChipPair {
  const { viewingLive, recorded, wire, boot } = input;
  if (!viewingLive) {
    return { provider: recorded.provider ?? undefined, model: recorded.model ?? undefined };
  }
  if (wire) return { provider: wire.provider, model: wire.model };
  if (recorded.provider !== null) {
    return { provider: recorded.provider, model: recorded.model ?? boot?.model ?? undefined };
  }
  return { provider: boot?.provider ?? undefined, model: boot?.model ?? undefined };
}
