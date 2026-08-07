// The recording, turned into the one format whisper.cpp reads — here, in the
// browser that made it (card 187 step 5.4).
//
// This used to be a child process. The browser POSTed its webm/opus blob, the
// server wrote it to a temp file, ran ffmpeg to make a 16 kHz mono WAV out of
// it, and handed that to whisper-cli. But the browser already HAS the audio: it
// recorded it, and Web Audio can hand over exactly what whisper wants. Doing it
// here removes ffmpeg from the server for good, which is worth more than the
// conversion it performed:
//
//   - the local path needs ONE binary instead of two, and whisper.cpp is MIT,
//     so the licence question ffmpeg raised leaves with the dependency,
//   - the server stops spawning a process per recording just to change a
//     container,
//   - and the llm-wire records the bytes that really went to the model rather
//     than a webm that something else rewrote first.
//
// The arithmetic below is pinned by tests. The Web Audio calls are not — they
// are a claim about a browser, and the honest place to check them is a live
// recording in the app.

/** whisper.cpp's one input rate. Anything else transcribes to nonsense. */
export const WHISPER_RATE = 16000;

/** Two bytes per sample, one channel. */
const BYTES_PER_SAMPLE = 2;

/** The header this module writes, and the only one it needs to. */
const HEADER_BYTES = 44;

/**
 * The longest clip that gets sent, in seconds.
 *
 * 16 kHz mono PCM is 32 kB per second, so this is a body of about 9.6 MB —
 * where the webm it replaces was a fraction of that. That trade is fine for
 * push-to-talk and unreasonable for someone who leans on the button, so the
 * size has a stated end. The hook stops the recorder here, which means the
 * limit costs the tail of a very long clip and never the whole recording.
 */
export const MAX_CLIP_SECONDS = 300;

/** The part of a decoded recording this module uses. The real thing is an
 *  `AudioBuffer`; naming only what is needed keeps the encoder testable. */
export interface Decoded {
  /** Length in seconds, as the decoder read it. */
  readonly duration: number;
}

/** The two Web Audio steps, as a seam: decode the container, then render one
 *  channel at a chosen rate. A fake in a test replaces both. */
export interface AudioShim {
  /** Container bytes (webm/opus, mp4, whatever the recorder chose) → samples. */
  decode(bytes: ArrayBuffer): Promise<Decoded>;
  /** Down-mix to mono and resample to `rate`. */
  monoAt(decoded: Decoded, rate: number): Promise<Float32Array>;
}

/**
 * Float samples to signed 16 bit, clamped.
 *
 * Clamped and not wrapped: Web Audio may hand over values a little past ±1, and
 * a wrap turns the loudest moment of a recording into its opposite — an audible
 * click exactly where someone spoke up.
 *
 * @param samples the rendered channel, nominally -1…1
 * @return one signed 16 bit sample each
 */
export function pcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Asymmetric on purpose: the signed range is -32768…32767, so each side is
    // scaled by its own maximum and neither overflows.
    pcm[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
  }
  return pcm;
}

/**
 * The canonical 44-byte WAV header plus the samples, little endian.
 *
 * @param pcm the signed 16 bit samples
 * @param sampleRate the rate they were rendered at
 * @return the complete file, ready to POST
 */
export function wavBytes(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataSize = pcm.length * BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(HEADER_BYTES + dataSize);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };

  ascii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true); // everything after this field
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // the fmt chunk is 16 bytes for PCM
  view.setUint16(20, 1, true); // 1 = uncompressed PCM
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // byte rate
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 8 * BYTES_PER_SAMPLE, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(HEADER_BYTES + i * BYTES_PER_SAMPLE, pcm[i], true);
  }
  return bytes;
}

/**
 * How long an encoded clip of this size runs, in seconds.
 *
 * @param byteLength the size of the whole file, header included
 * @return the duration at {@link WHISPER_RATE}
 */
export function clipSeconds(byteLength: number): number {
  return Math.max(0, byteLength - HEADER_BYTES) / (WHISPER_RATE * BYTES_PER_SAMPLE);
}

/**
 * A recording as it came off `MediaRecorder`, turned into a 16 kHz mono WAV.
 *
 * @param recording the container bytes the recorder produced
 * @param audio the two Web Audio steps
 * @param maxSeconds the ceiling; longer clips keep their beginning
 * @return the complete WAV file
 */
export async function wavFromRecording(
  recording: ArrayBuffer,
  audio: AudioShim,
  maxSeconds: number = MAX_CLIP_SECONDS,
): Promise<Uint8Array> {
  const decoded = await audio.decode(recording);
  const samples = await audio.monoAt(decoded, WHISPER_RATE);
  const ceiling = Math.round(maxSeconds * WHISPER_RATE);
  const kept = samples.length > ceiling ? samples.subarray(0, ceiling) : samples;
  return wavBytes(pcm16(kept), WHISPER_RATE);
}

/**
 * The real Web Audio pair.
 *
 * `decodeAudioData` resamples to the context's own rate, so the decoder is
 * built AT whisper's rate and the common case (a mono microphone) is already
 * finished when it returns. The render pass afterwards is what guarantees one
 * channel — and it runs off the main thread, which is why a long clip does not
 * freeze the composer while it converts.
 */
export const browserAudio: AudioShim = {
  async decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    return await new OfflineAudioContext(1, 1, WHISPER_RATE).decodeAudioData(bytes);
  },
  async monoAt(decoded: Decoded, rate: number): Promise<Float32Array> {
    const buffer = decoded as AudioBuffer;
    const frames = Math.max(1, Math.round(buffer.duration * rate));
    if (buffer.numberOfChannels === 1 && buffer.sampleRate === rate) {
      return buffer.getChannelData(0); // already what we asked for
    }
    const offline = new OfflineAudioContext(1, frames, rate);
    const source = offline.createBufferSource();
    source.buffer = buffer;
    source.connect(offline.destination);
    source.start();
    return (await offline.startRendering()).getChannelData(0);
  },
};
