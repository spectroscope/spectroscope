// Hosts one hook across time, without a DOM (card 527, fix round).
//
// drive() renders on React's server renderer, which drops a setState that
// arrives after the render returned. A hook whose work happens in awaits (a
// socket that opens, a ready frame, a timer) therefore cannot be followed
// there. This host can: a test file mocks "react" with `fakeHooks`, and every
// setState, from a render, an effect or an async continuation, renders the
// hook again. Effects run after each pass when their deps changed, cleanups
// before the next run and on unmount, as React runs them.
//
// It covers the hooks the voice input uses: useState, useRef, useEffect,
// useLayoutEffect, useCallback, useMemo and useSyncExternalStore. A hook that
// calls anything else gets the real React export, which throws outside a
// render; that is the signal to add it here.
//
// Test-only by construction: nothing under src/ imports this module except
// *.test.* files, so it never reaches the shipped bundle.

type Cleanup = void | (() => void);

interface EffectCell {
  deps: readonly unknown[] | undefined;
  seen: boolean;
  pending: (() => Cleanup) | null;
  cleanup: Cleanup;
}

let active: HookHost<unknown> | null = null;

function host(): HookHost<unknown> {
  if (active === null) throw new Error("a hook ran outside a HookHost");
  return active;
}

function sameDeps(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((v, i) => Object.is(v, b[i]));
}

/** One hook, rendered again on every state change. */
export class HookHost<T> {
  /** What the hook returned in its latest pass. */
  value!: T;
  /** How many passes ran. */
  renders = 0;
  private readonly cells: unknown[] = [];
  private readonly effects: EffectCell[] = [];
  private at = 0;
  private rendering = false;
  private dirty = false;
  private gone = false;

  constructor(private readonly hook: () => T) {
    this.render();
  }

  /** The cell at the current position, made on the first pass. */
  cell<S>(make: () => S): S {
    const i = this.at++;
    if (i === this.cells.length) this.cells.push(make());
    return this.cells[i] as S;
  }

  /** A new effect cell, run in order after each pass. */
  effectCell(): EffectCell {
    const e: EffectCell = { deps: undefined, seen: false, pending: null, cleanup: undefined };
    this.effects.push(e);
    return e;
  }

  /** State changed: render again now, or after the pass that is running. */
  invalidate(): void {
    if (this.gone) return;
    if (this.rendering) {
      this.dirty = true;
      return;
    }
    this.render();
  }

  /** Run every cleanup; later state changes do nothing. */
  unmount(): void {
    this.gone = true;
    for (const e of this.effects) if (typeof e.cleanup === "function") e.cleanup();
  }

  private render(): void {
    let passes = 0;
    this.rendering = true;
    try {
      do {
        if (++passes > 50) throw new Error("the hook rendered more than 50 times in a row");
        this.dirty = false;
        this.at = 0;
        const outer = active;
        active = this as HookHost<unknown>;
        try {
          this.value = this.hook();
          this.renders++;
        } finally {
          active = outer;
        }
        for (const e of this.effects) {
          const run = e.pending;
          if (run === null) continue;
          e.pending = null;
          if (typeof e.cleanup === "function") e.cleanup();
          e.cleanup = run();
        }
      } while (this.dirty && !this.gone);
    } finally {
      this.rendering = false;
    }
  }
}

function useEffectHere(effect: () => Cleanup, deps?: readonly unknown[]): void {
  const h = host();
  const e = h.cell(() => h.effectCell());
  if (!e.seen || !sameDeps(e.deps, deps)) e.pending = effect;
  e.seen = true;
  e.deps = deps;
}

function useMemoHere<V>(make: () => V, deps: readonly unknown[]): V {
  const m = host().cell(() => ({
    deps: undefined as readonly unknown[] | undefined,
    value: undefined as V,
    made: false,
  }));
  if (!m.made || !sameDeps(m.deps, deps)) {
    m.value = make();
    m.deps = deps;
    m.made = true;
  }
  return m.value;
}

/** The hooks a test file swaps into "react" with vi.mock. */
export const fakeHooks = {
  useState<S>(init: S | (() => S)): [S, (next: S | ((prev: S) => S)) => void] {
    const h = host();
    const c = h.cell(() => {
      const made = {
        value: typeof init === "function" ? (init as () => S)() : init,
        set: (next: S | ((prev: S) => S)): void => {
          const value = typeof next === "function" ? (next as (prev: S) => S)(made.value) : next;
          if (Object.is(value, made.value)) return;
          made.value = value;
          h.invalidate();
        },
      };
      return made;
    });
    return [c.value, c.set];
  },
  useRef<V>(init: V): { current: V } {
    return host().cell(() => ({ current: init }));
  },
  useEffect: useEffectHere,
  useLayoutEffect: useEffectHere,
  useMemo: useMemoHere,
  useCallback<F>(fn: F, deps: readonly unknown[]): F {
    return useMemoHere(() => fn, deps);
  },
  useSyncExternalStore<V>(_subscribe: (cb: () => void) => () => void, snapshot: () => V): V {
    return snapshot();
  },
};
