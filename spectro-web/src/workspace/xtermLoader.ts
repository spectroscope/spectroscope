// xterm.js, loaded on demand (card 93).
//
// THE COST, stated plainly: xterm is the one real dependency this feature adds.
// The alternative was a hand-rolled ANSI renderer, and that alternative is not
// honest — the shell is a login zsh with the operator's own .zshrc, so the pane
// has to survive oh-my-zsh's prompt rewriting, the erase-in-line every keystroke
// redraws with, and vim/htop on the alternate screen buffer with absolute cursor
// addressing. An append-a-span-per-SGR renderer cannot do that; it would look
// like it worked until the first `vim` and then paint garbage.
//
// The size is paid only by operators who open a terminal: this module is behind
// a dynamic import, so the VT engine and its stylesheet are their own chunk and
// the main bundle is byte-for-byte what it was before. xterm itself has zero
// runtime dependencies.

import type { Terminal, ITerminalOptions } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

export interface XtermApi {
  Terminal: new (options?: ITerminalOptions) => Terminal;
  FitAddon: new () => FitAddon;
}

let pending: Promise<XtermApi> | null = null;

/** Load the VT engine once per page; every tab after the first is instant. */
export function loadXterm(): Promise<XtermApi> {
  pending ??= (async () => {
    const [core, fit] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/xterm/css/xterm.css"),
    ]);
    return { Terminal: core.Terminal, FitAddon: fit.FitAddon };
  })().catch((failed: unknown) => {
    // A failed chunk must not poison the cache — the next open retries.
    pending = null;
    throw failed;
  });
  return pending;
}
