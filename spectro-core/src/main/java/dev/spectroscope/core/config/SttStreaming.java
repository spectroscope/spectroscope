package dev.spectroscope.core.config;

import dev.spectroscope.core.config.governing.Governs;

/**
 * The numbers that pace live text on the local speech route (card 527).
 *
 * <p>The local route has no streaming model. The server holds the audio of the
 * open window and runs {@code whisper-cli} over all of it every chunk step; the
 * answer replaces what the composer showed for that window. A window closes on
 * a sentence end followed by a pause, or when it reaches its length cap, and
 * the next one starts empty.</p>
 *
 * <p>These live in spectro-core so the governing registry carries them; the
 * server's {@code LocalWhisperUpstream} is the only reader.</p>
 */
public final class SttStreaming {

    private SttStreaming() {
        // constants only
    }

    /**
     * How often whisper-cli runs over the open window while someone speaks.
     * Chosen from a measurement on an Apple M4 Pro on 2026-10-11 (card 527,
     * evidence {@code measure/whisper-cli-per-window.json}): one whisper-cli
     * run with {@code ggml-small.bin}, model load included, took 444 to 953 ms
     * over 40 runs on windows of 3 to 30 s, median 670 ms, at a load average
     * of 21 to 29. Those windows held 18.8 s of speech and silence after it.
     * A second measurement in the fix round of the same day used windows that
     * hold speech from start to end ({@code measure/whisper-cli-30s-speech.json}):
     * a 30 s window took 958 to 1042 ms over 5 runs, median 1000 ms, and a
     * 20 s window 760 to 920 ms, at a load average of 46 to 72. The step is
     * about twice the slowest full window, so a run normally ends
     * well before the next one is due; a run that would overlap is skipped
     * and counted, never queued. A slower machine skips more runs and shows
     * words later; it does not fall behind without bound.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long STT_LOCAL_CHUNK_MS = 2_000L;

    /**
     * The longest window one whisper-cli run covers. The window closes here
     * with a final and the next one starts empty, so the audio a run reads,
     * and with it the run's wall time, stops growing. A 30 s window of speech
     * took a median of 1000 ms against 796 ms for 20 s (5 runs each,
     * 2026-10-11, see {@link #STT_LOCAL_CHUNK_MS}), so a full window ends
     * inside one chunk step. Audio longer than 30 s was not measured.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long STT_LOCAL_WINDOW_MS = 30_000L;

    /**
     * How much quiet audio at the end of the window counts as a pause. A
     * window closes early only when the run's text ends a sentence AND the
     * last this many milliseconds are quiet, so a comma breath does not split
     * a sentence. Not measured against real speakers and not tuned. In the
     * synthetic test speech (macOS {@code say}, 100 ms frames, 2026-10-11) the
     * quiet stretches between sentences were 200 to 400 ms, so no live check
     * closed a window before the trailing 1.5 s of silence; a window close in
     * the middle of a recording is unit tested only.
     */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.MILLISECONDS)
    public static final long STT_LOCAL_PAUSE_MS = 600L;

    /**
     * The loudness under which the pause audio counts as quiet: the root mean
     * square of the PCM16 samples as a share of full scale. 0.02 is about
     * minus 34 dBFS. Measured only on the synthetic test speech of card 527
     * (macOS say, 20.3 s, 100 ms frames, 2026-10-11): the frames at or above
     * 0.02 had a median of 0.18, the frames below it a maximum of 0.011. The
     * noise floor of a real microphone was not measured.
     */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.RATIO)
    public static final double STT_LOCAL_SILENCE_RMS = 0.02;

    /**
     * How long the browser waits for a live session to say it is ready before
     * it gives up and leaves the microphone idle. On the local route ready
     * comes after a warm up run of whisper-cli over one second of silence,
     * which loads the model; whisper-cli loads it again on every run.
     * Measured on 2026-10-11 with the model file already in the page cache:
     * 441 to 609 ms over 5 standalone runs, and 683 to 2070 ms from the
     * ready frame over 10 presses in the app's live checks, under load. A first
     * load from disk after a restart was not measured; 20 s is the card's
     * starting value.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long STT_WARMUP_TIMEOUT_MS = 20_000L;

    /**
     * How long a resident whisper-server stays up with nothing to do (card
     * 528). The owner's number of 2026-10-11: the model loads on the first
     * press behind the loading card, stays in memory for 30 minutes of idle
     * time and loads again on the next press after that. Idle means no
     * request in flight and none finished within this time. The process holds
     * the model in memory while it runs: 487 MB of weights in the log of
     * whisper-server 1.9.1 with {@code ggml-small.bin}, plus its buffers.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long STT_SERVER_IDLE_MS = 30L * 60L * 1000L;

    /**
     * What {@code sttRunner: auto} runs when whisper-server is installed:
     * {@code server} or {@code cli}. Chosen by the measurement of card 528;
     * the numbers and the method are in the card's Result. Without
     * whisper-server on the machine auto runs whisper-cli.
     */
    public static final String STT_RUNNER_AUTO_PICK = "server";
}
