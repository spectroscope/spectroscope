// The system context, asked for once per app — card 175.
//
// It is uploaded with every request as the "system" role but is not a wire
// event, so it can never appear as a frame of its own; the trace prepends ONE
// synthetic ↑ row for it, so that the "what gets uploaded" side is visible.
//
// The fetch used to ride TraceView's mount, and that mount has moved twice. It
// was once per tab press before card 175, once per app while the August build
// kept the view mounted, and — once the warm gate keys on the record that
// arrived — once per session opened. None of those is what the thing being
// fetched actually is: the operator's configuration does not change because a
// reader opened a different transcript. Measured on this branch before the fix:
// one fetch after two session opens on `main`, four after three opens here.
//
// Asking once is not a cache with a lifetime. Nothing here is stored, nothing
// is keyed on a record, and nothing can answer for the wrong session — the
// answer belongs to the app, and the app is what it is asked about.

/** What `/api/context` answers: the system side of every request. */
export interface TraceContext {
  systemPrompt: string;
  tools: { name: string }[];
  skills: { name: string }[];
  mcpServers: string[];
}

let asked: Promise<TraceContext | null> | null = null;

/**
 * The system context, fetched at most once for the lifetime of the page.
 *
 * Never rejects: a trace that threw here would render nothing at all, and the
 * synthetic row is worth losing where the 9,320 real ones are not.
 *
 * @return the context, or null when the server has none to give
 */
export function loadTraceContext(): Promise<TraceContext | null> {
  asked ??= fetch("/api/context")
    .then((r) => (r.ok ? (r.json() as Promise<TraceContext>) : null))
    .catch(() => null);
  return asked;
}

/** Test seam: forget the answer, so the next call asks again. */
export function forgetTraceContext(): void {
  asked = null;
}
