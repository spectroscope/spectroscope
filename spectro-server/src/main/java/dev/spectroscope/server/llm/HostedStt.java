package dev.spectroscope.server.llm;

import java.io.IOException;

/**
 * The hosted transcription leg as a seam, so {@link TranscribeController} is
 * testable without a network and without a key — the same reason
 * {@code CommandRunner} exists for the local leg.
 */
public interface HostedStt {

    /**
     * Post a recording and hand back the answer body untouched.
     *
     * @param wav the 16 kHz mono WAV the browser encoded
     * @param key the API key
     * @return the raw response body, so the caller records what really came back
     * @throws IOException with a readable sentence for any refusal
     */
    String post(byte[] wav, String key) throws IOException, InterruptedException;

    /** The model it posts with — named on the wire record. */
    String model();
}
