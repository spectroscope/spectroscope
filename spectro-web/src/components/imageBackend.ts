// Which image backend to show, when the configured one cannot generate.
//
// The owner's smart default, 2026-07-20: when the backend the settings name has
// no key and another one does, the composer offers the one that can actually
// make a picture. Card 222's review (finding F5) moved the ANSWER out of a
// remembered websocket frame and into this function, because the app announcing
// it with `set_image_provider` — the same message a human dropdown pick sends —
// made the session count the field as touched with nobody having touched
// anything, and the settings page's own image dropdown went dead for the rest of
// that session.
//
// So this decides what the composer SHOWS, and `ImageProviders.withAKey` decides
// what `generate_image` USES, from the same two inputs. The vector table in
// imageBackend.test.ts is the twin of the one in ImageProvidersTest.java.

import { IMAGE_MODELS } from "./imageModels";

/** Which image backends have a key, as /api/config reports presence (never
 *  values); null while the answer has not arrived, or from a server too old to
 *  say. */
export interface ImageKeys {
  gemini: boolean;
  openai: boolean;
}

/** The known backends, in the order a fallback prefers them — the same keys the
 *  model dropdown is built from, and the same order as `ImageProviders.BACKENDS`
 *  on the server. Never a second hand-written list. */
const BACKENDS: string[] = Object.keys(IMAGE_MODELS);

/**
 * The backend to offer for `named`: itself, unless it has no key and another
 * one does.
 *
 * @param named the backend the settings resolve to
 * @param keys  key presence per backend, or null while it is unknown — unknown
 *              changes nothing, because claiming "no key" against a server that
 *              never said so would move the dropdown off the real setting
 * @returns the backend to pre-select
 */
export function backendWithAKey(named: string, keys: ImageKeys | null): string {
  if (keys === null || !BACKENDS.includes(named)) {
    return named;
  }
  const has = (backend: string): boolean => keys[backend as keyof ImageKeys] === true;
  if (has(named)) {
    return named;
  }
  return BACKENDS.find(has) ?? named;
}
