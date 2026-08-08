// Which microphone, remembered (card 187 step 2).
//
// `getUserMedia({audio:true})` takes whatever the OS calls default, and the
// owner's own machine offers five inputs including two virtual ones — so
// "default" was a coin toss between a webcam, a headset and a loopback device.
//
// Persisted like the trace's columns and filter, on the same idiom.
//
// ⚠️ THE RULE THAT KEEPS THE LIST HONEST: `enumerateDevices()` returns entries
// with an EMPTY `label` until permission has been granted at least once. A
// picker that rendered those would show five blank rows and look broken. So the
// unnamed case is a state the pane says out loud, not one it paints.

import { useSyncExternalStore } from "react";

export interface MicDevice {
  deviceId: string;
  label: string;
}

/** What a picker can offer, and why it cannot. */
export interface MicChoice {
  devices: readonly MicDevice[];
  /** True when devices exist but none has a name yet — permission has never
   *  been granted, so the browser withholds the labels. */
  unnamed: boolean;
}

const KEY = "spectroscope:mic.device";

let chosen: string | null = readSaved();
const listeners = new Set<() => void>();

function readSaved(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null || raw === "" ? null : raw;
  } catch {
    return null; // no localStorage (tests)
  }
}

/**
 * Read the browser's device list into what a picker may show.
 *
 * @param all everything `enumerateDevices()` returned, of any kind
 * @return the audio inputs, and whether the browser is still withholding names
 */
export function readMicDevices(all: readonly MediaDeviceInfo[]): MicChoice {
  const inputs = all.filter((d) => d.kind === "audioinput");
  const devices = inputs.map((d) => ({ deviceId: d.deviceId, label: d.label }));
  // Every name empty means permission has never been granted. ONE named device
  // among them is enough to show the list: the browser gives all or nothing,
  // and a partial list is a browser we should not out-guess.
  const unnamed = devices.length > 0 && devices.every((d) => d.label === "");
  return { devices, unnamed };
}

/**
 * The constraint to hand `getUserMedia`.
 *
 * A remembered device that has since been unplugged must NOT be demanded:
 * `exact` would fail the whole call and take the microphone away over a
 * preference. So the id is a wish, and the browser may fall back.
 *
 * @param deviceId the remembered choice, or null
 * @return the audio constraint
 */
export function audioConstraint(deviceId: string | null): MediaTrackConstraints | true {
  return deviceId === null ? true : { deviceId: { ideal: deviceId } };
}

export function setMicDevice(deviceId: string | null): void {
  if (chosen === deviceId) return;
  chosen = deviceId;
  try {
    if (deviceId === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, deviceId);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

/** Visible for tests. */
export function currentMicDevice(): string | null {
  return chosen;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): string | null {
  return chosen;
}

export function useMicDevice(): string | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
