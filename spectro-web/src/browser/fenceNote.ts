// The browser panel's footer sentence about the net fence (card 355).
//
// The line used to be one frozen string rendered at two sites. It told every
// operator "localhost needs allowLocalhost" forever — including the one whose
// ~/.spectro/settings.json already carries `"allowLocalhost": true`, in a
// footer he cannot dismiss, on a panel card 336 measured as capped near half
// the window. A true statement that does not know the reader's state.
//
// So the note is composed here instead: the rules that always hold, the
// loopback clause that depends on this process's own setting, and the honest
// limit. WHERE the line lives is not decided here — it still stands
// permanently under both faces, because whether it stops being permanent is
// the owner's call and he has not made it.

import { useEffect, useState } from "react";
import { t, type Lang } from "../i18n/i18n";
import { fetchSettings } from "../state/serverSettings";

/**
 * The fence's loopback opt-in as this panel knows it: on, off, or null for
 * "nobody has said".
 *
 * <p>Null is a real third answer and not a stand-in for false. The settings
 * fetch can be in flight, or fail; guessing "off" in that window would put
 * the very sentence card 355 was written about back on the screen, and
 * guessing "on" would promise a reach the fence may not grant. Card 344 fixed
 * the same shape one file over: an unknown answer leaves the surface alone.
 */
export type LoopbackGate = boolean | null;

/**
 * The footer sentence for a given language and loopback state.
 *
 * @param lang the chrome language
 * @param gate whether loopback is opted in, or null when it is not known
 * @return the whole note — rules, the loopback clause where there is one to
 *         make, and the DNS limit, which is in every variant
 */
export function fenceNote(lang: Lang, gate: LoopbackGate): string {
  const rules = t(lang, "browser.fence.rules");
  const dns = t(lang, "browser.fence.dns");
  if (gate === null) return `${rules}. ${dns}`;
  const loopback = t(lang, gate ? "browser.fence.loopbackOn" : "browser.fence.loopbackOff");
  return `${rules}; ${loopback}. ${dns}`;
}

/**
 * The loopback opt-in as the settings API resolves it, or null when it cannot
 * be known.
 *
 * <p>`allowLocalhost` is a process-global field — SpectroConfig refuses it in
 * a workspace scope (card 199) — so this asks the session-less view, the same
 * resolution the fence itself was built from. Asking with a session would join
 * scopes that are not allowed to answer this question.
 *
 * <p>Two ways to end up at null, and both mean the same thing to the note: the
 * server did not answer, or it answered without the field. Neither is an
 * excuse to guess.
 */
export async function readLoopbackGate(): Promise<LoopbackGate> {
  try {
    const view = await fetchSettings();
    const raw = view.effective.allowLocalhost;
    return typeof raw === "boolean" ? raw : null;
  } catch {
    // No server, or a restart mid-read. The note simply says nothing about
    // localhost — see LoopbackGate on why that beats a guess.
    return null;
  }
}

/** The gate as React state: null until the read lands, then whatever it said.
 *  Read once per mount; the fence is built at process start and a settings
 *  change that moves it needs a restart anyway. */
export function useLoopbackGate(): LoopbackGate {
  const [gate, setGate] = useState<LoopbackGate>(null);
  useEffect(() => {
    let live = true;
    void readLoopbackGate().then((next) => {
      if (live) setGate(next);
    });
    return () => {
      live = false;
    };
  }, []);
  return gate;
}
