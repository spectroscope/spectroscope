package dev.spectroscope.cli.speech;

/**
 * The process boundary of voice output, behind one narrow interface so the
 * {@link SpeechRenderer}'s real logic — sentence segmentation, the bounded
 * synthesis-ahead queue, and abort clearing it — is testable WITHOUT a real
 * piper binary or an audio player on the machine. Production wires
 * {@link PiperSpeechEngine}; a test injects a fake that records the sentences it
 * was asked to speak and asserts the segmentation, the playback order, and that
 * a cancel empties the queue.
 *
 * <p>Two operations, matching the two child processes the blueprint prescribes:
 * a one-shot synthesis (piper: sentence in, an audio {@link Clip} out) and a
 * playback that starts a player process and hands back a {@link Playback} handle
 * the renderer can wait on or destroy. Nothing else about the flow (the buffer,
 * the queue, the code-block and markdown hygiene) touches a process — so nothing
 * else needs a binary to be exercised.</p>
 */
public interface SpeechEngine {

    /**
     * Whether piper, the voice model and an audio player are all present. Checked
     * once by the renderer; when false, voice output disables itself with a
     * readable hint pointing at {@code scripts/setup-tts.sh}. A fake returns true.
     *
     * @return true only when synthesis AND playback can work end to end
     */
    boolean isAvailable();

    /**
     * Synthesizes one sentence into a playable {@link Clip} (production: a WAV
     * file written by piper). Runs to completion — a blocking child process on a
     * virtual thread. The returned clip is later handed to {@link #play}.
     *
     * @param sentence one finished sentence from the renderer's segmentation, markdown already stripped
     * @return the synthesized clip, carrying the sentence and its audio artifact
     * @throws Exception if synthesis fails; the renderer then skips the sentence
     *                   (its text is already in the terminal)
     */
    Clip synthesize(String sentence) throws Exception;

    /**
     * Starts playback of a synthesized {@link Clip} and returns a {@link Playback}
     * handle immediately (production: a started player process, e.g. afplay). The
     * renderer's playback loop then blocks on {@link Playback#await()}; an abort
     * calls {@link Playback#stop()} on the running handle so it dies at once — no
     * ghost sentences. Never started through a shell, or {@code stop()} would only
     * hit the shell.
     *
     * @param clip a clip previously produced by {@link #synthesize}
     * @return the handle of the now-running playback — await it or stop it
     * @throws Exception if the player cannot start; the renderer skips the sentence
     */
    Playback play(Clip clip) throws Exception;

    /**
     * One synthesized sentence, ready to play. Production carries the WAV path and
     * cleans it up on {@link #discard()}; a test can carry just the sentence text.
     */
    interface Clip {
        /**
         * The sentence this clip speaks — kept so a fake can assert order.
         *
         * @return the exact text handed to {@link SpeechEngine#synthesize}
         */
        String sentence();

        /** Best-effort cleanup of the artifact (production: delete the WAV). */
        void discard();
    }

    /** A running playback: block until it finishes, or destroy it on abort. */
    interface Playback {
        /** Blocks until playback finishes (or is stopped). Never throws. */
        void await();

        /** Terminates the running player immediately — the abort path. */
        void stop();
    }
}
