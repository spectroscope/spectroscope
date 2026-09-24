// Card 379: what the composer popover needs to draw the rtk switch.
//
// Unlike every other section of that popover, this one is NOT a browser
// preference. `rtkFilter` is a server setting: the value is read from the
// settings API and written back to it, and the local state in this hook is only
// what the row draws between the click and the server's answer. Today the
// setting reaches the main agent of a browser session and nothing else.
// `spectro run`, a cron fire, a fleet node and a child agent do not read it
// (owner calls 12 and 13 on card 379).
//
// Two facts come from `/api/config` and not from settings, because they are
// facts about the MACHINE rather than about the configuration: whether rtk
// resolves where the agent's shell looks, and which version answered. The
// version is printed, never assumed. Card 379 was measured against 0.45.0 and the latest
// release at the time was 0.49.0, so a literal in this file would have been
// wrong for some readers on the day it was written.

import { useEffect, useState } from "react";
import { fetchSettings } from "./serverSettings";

/** What the popover row needs, plus the two setters it uses for the optimistic
 *  flip and the rollback when the save is refused. */
export interface RtkFilterState {
  /** Whether the switch is on, as last read or optimistically set. */
  on: boolean;
  /** Whether rtk resolves where the agent's shell looks, on the machine the
   *  server runs on. */
  available: boolean;
  /** What `rtk --version` printed, or "" when it does not resolve. */
  version: string;
  /** The last save error, or null. */
  error: string | null;
  /** Flips the drawn state before the server has answered. */
  setOn: (next: boolean) => void;
  /** Records a refused save so the row can say what went wrong. */
  setError: (message: string | null) => void;
}

/** What `/api/config` says about rtk on the server's machine. */
export interface RtkProbe {
  /** Whether rtk resolves where the agent's shell looks. */
  available: boolean;
  /** What `rtk --version` printed, or "". */
  version: string;
}

/**
 * Reads the `rtk` block of an `/api/config` body. Anything that is not the
 * shape the server writes reads as rtk missing, which is also what the server
 * does with a binary it cannot run: the line runs as the model wrote it.
 *
 * @param body the parsed `/api/config` response
 * @returns availability and the version string, passed through verbatim
 */
export function rtkProbeFrom(body: unknown): RtkProbe {
  const rtk = (body as { rtk?: { available?: unknown; version?: unknown } } | null)?.rtk;
  return {
    available: rtk?.available === true,
    version: typeof rtk?.version === "string" ? rtk.version : "",
  };
}

/**
 * What a click on the row saves.
 *
 * @param rtk the drawn state
 * @returns the value to save, or null when rtk is missing and the row is dead
 */
export function rtkNextValue(rtk: { on: boolean; available: boolean }): "on" | "off" | null {
  if (!rtk.available) return null;
  return rtk.on ? "off" : "on";
}

/**
 * Reads the switch and the machine's rtk, refreshed each time the menu opens.
 *
 * Refreshing on open rather than once on mount is deliberate: the settings file
 * is also editable on the settings page and by hand, and a popover that shows a
 * stale switch is the shape of defect card 222 is the bill for. It is cheap,
 * because it happens only when somebody looks.
 *
 * @param open whether the popover is currently open
 * @returns what the row draws, and the two setters it flips with
 */
export function useRtkFilter(open: boolean): RtkFilterState {
  const [on, setOn] = useState(false);
  const [available, setAvailable] = useState(false);
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    void (async () => {
      try {
        const view = await fetchSettings();
        if (live) setOn(view.effective["rtkFilter"] === "on");
      } catch {
        /* the row keeps what it had; a settings read is not worth an alarm */
      }
      try {
        const res = await window.fetch("/api/config");
        if (!res.ok) return;
        const probe = rtkProbeFrom(await res.json());
        if (!live) return;
        setAvailable(probe.available);
        setVersion(probe.version);
      } catch {
        /* no probe: the row renders disabled and says rtk was not found */
      }
    })();
    return () => {
      live = false;
    };
  }, [open]);

  return { on, available, version, error, setOn, setError };
}
