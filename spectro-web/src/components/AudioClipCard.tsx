// The structured face of an stt request: the recording as a thing you can
// PLAY, not a wall of base64 (card 184/187, owner 2026-08-09).
//
// Four readers stacked on one clock: a waveform with the spectrum strip's
// scrub mechanics, a transport with the clip clock, the transcript cut into
// words that light up as the playhead passes them, and a sliding window over
// the ENCODED text that says which characters of the recorded base64 are
// playing right now. The last one is the trace being honest about itself: the
// body really is base64, and this pane shows where in it you are instead of
// pretending the encoding away.
//
// All arithmetic lives in wire/audioClip.ts and is pinned; this file owns Web
// Audio, the canvas and the pointer — untested by the house rule (micLevel.ts).
//
// This is the app's first playback surface. The AudioContext is created on
// the first press (a user gesture, so autoplay policy never blocks it) and
// closed on unmount.
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { useDesignPrefs } from "../state/designPrefs";
import {
  base64OffsetAt,
  base64WindowAt,
  bytesOfBase64,
  clockOf,
  estimatedWordSpans,
  parseWav,
  transcriptOf,
  waveformBins,
  wordIndexAt,
  type WavClip,
} from "../wire/audioClip";

/** Characters of encoded text shown around the playhead. */
const ENCODED_WINDOW = 48;

export function AudioClipCard({ body, responseBody }: { body: string; responseBody: string | null }) {
  const lang = useLang();
  const { prefs } = useDesignPrefs();

  const clip = useMemo<WavClip | null>(() => {
    const bytes = bytesOfBase64(body);
    return bytes === null ? null : parseWav(bytes);
  }, [body]);
  const transcript = useMemo(() => transcriptOf(responseBody), [responseBody]);
  const spans = useMemo(
    () => (clip !== null && transcript !== null ? estimatedWordSpans(transcript, clip.seconds) : []),
    [clip, transcript],
  );

  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);

  // The one clock. While playing, position = anchorPos + (ctx.now - anchorAt);
  // everything else (words, window, playhead) derives from it per frame.
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const anchorRef = useRef<{ pos: number; at: number }>({ pos: 0, at: 0 });
  const rafRef = useRef(0);
  const scrubbingRef = useRef(false);

  const stopSource = (): void => {
    const s = sourceRef.current;
    sourceRef.current = null;
    if (s !== null) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
  };

  const currentPos = (): number => {
    const ctx = ctxRef.current;
    if (ctx === null || sourceRef.current === null) return pos;
    return Math.min(anchorRef.current.pos + (ctx.currentTime - anchorRef.current.at), clip?.seconds ?? 0);
  };

  const startAt = (from: number): void => {
    if (clip === null) return;
    const ctx = ctxRef.current ?? new AudioContext();
    ctxRef.current = ctx;
    // A context born outside a user gesture starts suspended and its clock
    // never moves — the source "plays" into silence at position zero. Resume
    // is idempotent and cheap, so it runs on every start rather than on a
    // state we would have to guess.
    void ctx.resume().catch(() => undefined);
    if (bufferRef.current === null) {
      const frames = Math.floor(clip.samples.length / clip.channels);
      const buffer = ctx.createBuffer(clip.channels, Math.max(1, frames), clip.sampleRate);
      for (let ch = 0; ch < clip.channels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) data[i] = clip.samples[i * clip.channels + ch] / 32768;
      }
      bufferRef.current = buffer;
    }
    stopSource();
    const source = ctx.createBufferSource();
    source.buffer = bufferRef.current;
    source.connect(ctx.destination);
    const offset = Math.min(Math.max(from, 0), clip.seconds);
    source.onended = () => {
      if (sourceRef.current === source) {
        sourceRef.current = null;
        setPlaying(false);
        setPos(clip.seconds);
      }
    };
    anchorRef.current = { pos: offset, at: ctx.currentTime };
    source.start(0, offset);
    sourceRef.current = source;
    setPlaying(true);
  };

  const pause = (): void => {
    setPos(currentPos());
    stopSource();
    setPlaying(false);
  };

  const toggle = (): void => {
    if (playing) pause();
    else startAt(pos >= (clip?.seconds ?? 0) ? 0 : pos);
  };

  const seek = (to: number, keepPlaying: boolean): void => {
    const clamped = Math.min(Math.max(to, 0), clip?.seconds ?? 0);
    if (keepPlaying) startAt(clamped);
    else {
      stopSource();
      setPlaying(false);
      setPos(clamped);
    }
  };

  // The frame loop runs only while it has something to move.
  useEffect(() => {
    if (!playing) return;
    const tick = (): void => {
      setPos(currentPos());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Unmount: stop the source and close the context — the first playback
  // surface must not be the first playback leak.
  useEffect(
    () => () => {
      stopSource();
      void ctxRef.current?.close().catch(() => undefined);
      ctxRef.current = null;
    },

    [],
  );

  // ------------------------------------------------------------- waveform
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (canvas === null || wrap === null || clip === null) return;
    const draw = (): void => {
      const w = wrap.clientWidth;
      const h = 56;
      if (w <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2); // ParticleField's cap
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx2d = canvas.getContext("2d");
      if (ctx2d === null) return;
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h);
      const style = getComputedStyle(canvas);
      const ink = style.getPropertyValue("--text-faint").trim() || "#888";
      const bins = waveformBins(clip.samples, w);
      ctx2d.fillStyle = ink;
      const mid = h / 2;
      for (let x = 0; x < bins.length; x++) {
        const half = Math.max(0.75, bins[x] * (h / 2 - 2));
        ctx2d.fillRect(x, mid - half, 1, half * 2);
      }
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [clip, prefs.design]);

  // Scrub: the spectrum strip's pointer contract — capture on down, move
  // gated by the capture, release ends the gesture. touch-action:none in CSS.
  const posOfEvent = (e: React.PointerEvent): number => {
    const el = wrapRef.current;
    if (el === null || clip === null) return 0;
    const rect = el.getBoundingClientRect();
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    return frac * clip.seconds;
  };
  const wasPlayingRef = useRef(false);
  const onPointerDown = (e: React.PointerEvent): void => {
    if (clip === null) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbingRef.current = true;
    wasPlayingRef.current = playing;
    seek(posOfEvent(e), false);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!scrubbingRef.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    seek(posOfEvent(e), false);
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    seek(posOfEvent(e), wasPlayingRef.current);
  };

  if (clip === null) {
    // Not readable PCM16: say so and show the measure, never the characters.
    return (
      <div className="audio-clip">
        <p className="trace-source-note">{t(lang, "trace.llm.audio.unreadable")}</p>
        <span className="img-blobmark llm-wire-mark">
          {t(lang, "shot.blob", { chars: body.length.toLocaleString() })}
        </span>
      </div>
    );
  }

  const encodedAt = base64OffsetAt(pos, clip, body.length);
  const win = base64WindowAt(body, encodedAt, ENCODED_WINDOW);
  const nowWord = wordIndexAt(spans, pos);
  const frac = clip.seconds > 0 ? pos / clip.seconds : 0;

  return (
    <div className="audio-clip">
      <div className="audio-clip-row">
        <button
          type="button"
          className="icon-button audio-clip-toggle"
          onClick={toggle}
          aria-label={t(lang, playing ? "trace.llm.audio.pause" : "trace.llm.audio.play")}
          title={t(lang, playing ? "trace.llm.audio.pause" : "trace.llm.audio.play")}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
              <rect x="3" y="3" width="10" height="10" rx="1.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
              <path d="M4.5 2.5l9 5.5-9 5.5z" />
            </svg>
          )}
        </button>
        <div
          ref={wrapRef}
          className="audio-clip-wave"
          role="slider"
          tabIndex={0}
          aria-label={t(lang, "trace.llm.audio.scrub")}
          aria-valuemin={0}
          aria-valuemax={Math.round(clip.seconds * 10) / 10}
          aria-valuenow={Math.round(pos * 10) / 10}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              toggle();
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              seek(pos - 2, playing);
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              seek(pos + 2, playing);
            }
          }}
        >
          <canvas ref={canvasRef} aria-hidden="true" />
          <span className="audio-clip-playhead" style={{ left: `${frac * 100}%` }} aria-hidden="true" />
        </div>
        <span className="audio-clip-clock mono tabular">
          {clockOf(pos)} / {clockOf(clip.seconds)}
        </span>
      </div>

      {spans.length > 0 && (
        <p className="audio-clip-words" title={t(lang, "trace.llm.audio.estimated")}>
          {spans.map((s, i) => (
            <span
              key={i}
              className={i === nowWord ? "audio-word audio-word--now" : "audio-word"}
              onClick={() => seek(s.start, playing)}
            >
              {s.word}{" "}
            </span>
          ))}
        </p>
      )}
      {spans.length > 0 && <p className="audio-clip-note">{t(lang, "trace.llm.audio.estimated")}</p>}

      {/* The sliding window over the ENCODED text: which characters of the
          recorded base64 are playing right now. The window is inert — the
          full body stays one face away on the wire, uncut. */}
      <div className="audio-clip-encoded mono" aria-hidden="true">
        <span className="audio-clip-encoded-text">{win.text}</span>
        <span className="audio-clip-encoded-at tabular">
          {t(lang, "trace.llm.audio.encodedAt", {
            at: encodedAt.toLocaleString(),
            total: body.length.toLocaleString(),
          })}
        </span>
      </div>
    </div>
  );
}
