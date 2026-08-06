// The one way any picture, anywhere, asks to be opened.
//
// A picture is drawn in a chat bubble, on a tool card and in a trace row, and
// none of those knows about the others. The lightbox walks from one to the next,
// so it cannot live inside any of them.
//
// A MODULE STORE rather than a React context, and the reason is a diff. The
// first version wrapped App's whole render in a `<Provider>`, which re-indented
// 1,241 lines of JSX and would have buried a 40-line feature in an unreadable
// change. It is also the house idiom already: stepper.ts, sendQueue and
// aboutSignal all reach across the tree this way.

import { useSyncExternalStore } from "react";
import type { UserAttachment } from "./reducer";

let pending: UserAttachment | null = null;
let seq = 0;
const listeners = new Set<() => void>();

/** Ask the app to open its gallery at this picture. Safe to call from anywhere. */
export function openImage(shot: UserAttachment): void {
  pending = shot;
  seq++;
  for (const l of listeners) l();
}

/** What the app should open, and a counter so clicking the SAME picture twice
 *  after closing the lightbox opens it again — a value-only signal would look
 *  unchanged and do nothing the second time. */
export interface ImageRequest {
  shot: UserAttachment | null;
  seq: number;
}

let snapshot: ImageRequest = { shot: null, seq: 0 };

function getSnapshot(): ImageRequest {
  if (snapshot.seq !== seq || snapshot.shot !== pending) snapshot = { shot: pending, seq };
  return snapshot;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The latest request, for the one component that owns the lightbox. */
export function useImageRequest(): ImageRequest {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
