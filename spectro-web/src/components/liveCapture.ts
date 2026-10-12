// The microphone, handed over in pieces while it is still open (card 187 step 6).
//
// The batch path records with `MediaRecorder`, waits for `onstop`, and converts
// the whole clip in one go (wavClip.ts). None of that shape survives a live
// session: there is no "stop" to wait for, and the thing that has to travel is
// raw PCM as it is captured. So this is a different instrument for a different
// job, and the two live side by side rather than one growing a flag.
//
// What is pure here is tested; the Web Audio wiring is not, for the reason
// wavClip.ts gives about its own: a claim about a browser is checked by running
// it in the browser we ship, not by a unit test. The live proof for this file is
// a recording made in the app.

import { LIVE_RATE } from "./liveTranscription";
import { APPEND_MS, appendFrames, base64Pcm } from "./pcmChunks";

/**
 * The worklet that taps the capture graph.
 *
 * <p>Shipped as source rather than as a file, so there is no asset to serve and
 * nothing to load before the microphone can be armed — the same reason the arming
 * click is a synthesized tone. It is registered from a blob URL at start.</p>
 *
 * Two details that are bugs if they are missing, and both are pinned by tests:
 * `process()` runs every 128 frames (about 5 ms at the live rate), so posting
 * each one would be ~190 socket frames a second; and Web Audio REUSES the input
 * buffer between calls, so a frame handed over without a copy is overwritten
 * before anything reads it.
 */
export const PCM_TAP_SOURCE = `
class PcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chunk = options.processorOptions.chunk;
    this.buffer = new Float32Array(this.chunk);
    this.at = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.buffer[this.at++] = input[i];
      if (this.at === this.chunk) {
        this.port.postMessage(this.buffer.slice());
        this.at = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-tap", PcmTap);
`;

/**
 * Where the live socket lives, from the origin the page was served from.
 *
 * Never a hardcoded host: the desktop shell picks its port at runtime (card
 * 168), the dev server runs on 5173 against a proxy, and a page served over
 * https cannot open a `ws://` socket at all — that is blocked as mixed content
 * and the failure looks exactly like the server being down.
 *
 * @param origin the page's own origin, e.g. `location.origin`
 * @return the websocket URL
 */
export function liveSocketUrl(origin: string): string {
  return `${origin.replace(/^http/, "ws")}/ws/stt`;
}

/** A live capture in flight. */
export interface LiveCapture {
  /** The speaker let go: stop capturing and ask for the transcript. */
  commit(): void;
  /** Tear it all down — worklet, context and socket. */
  close(): void;
}

/** A live socket that is open, before the microphone joins it (card 527). */
export interface LiveSession {
  /** The server's ready, with its warm up time when it named one. Rejects
   *  when the session is refused or closes first. */
  readonly ready: Promise<{ warmupMs: number | null }>;
  /** Build the audio graph on the microphone and start sending. */
  attach(stream: MediaStream, rate: number): Promise<LiveCapture>;
  /** Close the socket. */
  close(): void;
}

/**
 * Open the live socket and hand every frame to `onFrame`.
 *
 * <p>The socket opens FIRST, because the server answers a refused route with a
 * reason and closes, and there is no point building an audio graph for a
 * session that will not happen. Since card 527 the caller also waits for
 * `ready` before it captures the microphone: on the local route ready means
 * the model is loaded.</p>
 *
 * @param onFrame every parsed frame from the server, in order
 * @return the open session
 */
export async function openLiveSession(onFrame: (frame: unknown) => void): Promise<LiveSession> {
  const socket = new WebSocket(liveSocketUrl(window.location.origin));
  let settle: { resolve(v: { warmupMs: number | null }): void; reject(e: Error): void } | null = null;
  const ready = new Promise<{ warmupMs: number | null }>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Nobody may be waiting yet; an unhandled rejection is not news.
  ready.catch(() => {});
  const answer = (frame: unknown): void => {
    const f = frame as { type?: unknown; warmupMs?: unknown; reason?: unknown } | null;
    if (settle === null || f === null || typeof f !== "object") return;
    if (f.type === "ready") {
      settle.resolve({ warmupMs: typeof f.warmupMs === "number" ? f.warmupMs : null });
      settle = null;
    } else if (f.type === "error" || f.type === "closed") {
      settle.reject(new Error(typeof f.reason === "string" ? f.reason : String(f.type)));
      settle = null;
    }
  };
  socket.onmessage = (event: MessageEvent<string>) => {
    let frame: unknown;
    try {
      frame = JSON.parse(event.data);
    } catch {
      // A frame we cannot read is one lost update, not a lost recording.
      return;
    }
    answer(frame);
    onFrame(frame);
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error("the live transcription socket did not open"));
  });
  // A close from here on is news for the caller, not a rejection: the server
  // says why (a refused route closes immediately) and the reducer reads it.
  socket.onclose = () => {
    answer({ type: "closed" });
    onFrame({ type: "closed" });
  };

  return {
    ready,
    close: () => socket.close(),
    attach: async (stream: MediaStream, rate: number): Promise<LiveCapture> => {
      // The rate is the route's (card 527): 24 kHz for the hosted session,
      // 16 kHz for whisper on the local route. `captureRate` decides it.
      const ctx = new AudioContext({ sampleRate: rate });
      // The commit stops the audio graph and the close after the wire frame ends
      // the rest, so both reach the context; it closes once (card 527: a second
      // close rejected and surfaced as a page error after every send).
      let ctxClosed = false;
      const closeContext = (): void => {
        if (ctxClosed) return;
        ctxClosed = true;
        void ctx.close().catch(() => {});
      };
      let tap: AudioWorkletNode;
      try {
        const moduleUrl = URL.createObjectURL(new Blob([PCM_TAP_SOURCE], { type: "application/javascript" }));
        try {
          await ctx.audioWorklet.addModule(moduleUrl);
        } finally {
          // The worklet is compiled by now; holding the blob would leak it for the
          // lifetime of the document.
          URL.revokeObjectURL(moduleUrl);
        }

        tap = new AudioWorkletNode(ctx, "pcm-tap", {
          processorOptions: { chunk: appendFrames(rate, APPEND_MS) },
        });
        tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
          if (socket.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({ type: "audio", data: base64Pcm(event.data) }));
        };
        // Into the tap and no further: connecting to ctx.destination would play the
        // speaker's own voice back at them through their speakers.
        ctx.createMediaStreamSource(stream).connect(tap);
      } catch (failed) {
        // Card 528: a graph that failed to build leaves no AudioContext open.
        // The caller stops the microphone and closes the socket (liveArm.ts).
        closeContext();
        throw failed;
      }

      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        tap.port.onmessage = null;
        tap.disconnect();
        closeContext();
        // Closing our socket is what takes the provider session down with it: the
        // server ties the two together deliberately, so this is the whole cleanup.
        socket.close();
      };

      return {
        commit(): void {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "commit" }));
          }
          // The audio graph stops here; the socket stays open for the transcript,
          // which arrives after the last append has been chewed through.
          tap.port.onmessage = null;
          tap.disconnect();
          closeContext();
        },
        close,
      };
    },
  };
}

/**
 * Open a live session and start feeding it at once, without waiting for
 * ready. Kept for callers that hold the microphone already.
 *
 * @param stream the microphone, already granted
 * @param onFrame every parsed frame from the server, in order
 * @param rate the capture rate, from `captureRate`
 * @return the handle, once the socket is open
 */
export async function startLiveCapture(
  stream: MediaStream,
  onFrame: (frame: unknown) => void,
  rate: number = LIVE_RATE,
): Promise<LiveCapture> {
  const session = await openLiveSession(onFrame);
  return session.attach(stream, rate);
}
