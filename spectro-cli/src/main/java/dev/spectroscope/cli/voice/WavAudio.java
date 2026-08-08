package dev.spectroscope.cli.voice;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Optional;

/**
 * Is this really the audio whisper.cpp can read?
 *
 * <p>{@link Transcriber} has always documented its one input format — 16 kHz
 * mono 16-bit PCM — and never checked it, because ffmpeg produced the file and
 * the guarantee was structural. Card 187 step 5.4 moved that conversion into
 * the browser, so the guarantee now depends on the caller, and a guarantee that
 * depends on a caller is a check.</p>
 *
 * <p>The cost of not checking is on the record. Card 184 watched a
 * Content-Type-less POST get chewed by the form parser, ffmpeg fail, its exit
 * code get ignored, and whisper's HELP TEXT come back as a 200 "transcript".
 * Wrong audio has to produce a sentence naming what was wrong, because the one
 * thing it must never produce is a plausible answer.</p>
 *
 * <p>Pure and static: every answer here is arithmetic over a header, which is
 * exactly the kind of thing that should be pinned rather than believed.</p>
 */
public final class WavAudio {

    /** The rate whisper.cpp expects; anything else transcribes to nonsense. */
    public static final int REQUIRED_RATE = 16000;

    /** Uncompressed PCM — the format code in a WAV `fmt ` chunk. */
    private static final int FORMAT_PCM = 1;

    /** RIFF's fixed preamble: "RIFF" + size + "WAVE" before the first chunk. */
    private static final int FIRST_CHUNK = 12;

    private WavAudio() {
    }

    /**
     * What is wrong with these bytes, if anything.
     *
     * @param audio the request body exactly as it arrived
     * @return a readable sentence, or empty when whisper can read this
     */
    public static Optional<String> problem(byte[] audio) {
        if (audio == null || audio.length < 44) {
            return Optional.of("Not a WAV recording: " + (audio == null ? 0 : audio.length)
                    + " bytes is too short to carry a header.");
        }
        ByteBuffer buffer = ByteBuffer.wrap(audio).order(ByteOrder.LITTLE_ENDIAN);
        if (!tag(buffer, 0).equals("RIFF") || !tag(buffer, 8).equals("WAVE")) {
            return Optional.of("Not a WAV recording — the browser must convert to "
                    + REQUIRED_RATE + " Hz mono PCM before posting.");
        }
        int fmt = findChunk(buffer, "fmt ");
        if (fmt < 0 || fmt + 16 > audio.length) {
            return Optional.of("Not a readable WAV recording: no format chunk.");
        }
        int format = buffer.getShort(fmt) & 0xFFFF;
        int channels = buffer.getShort(fmt + 2) & 0xFFFF;
        int rate = buffer.getInt(fmt + 4);
        int bits = buffer.getShort(fmt + 14) & 0xFFFF;

        if (format != FORMAT_PCM || bits != 16) {
            return Optional.of("Unsupported WAV payload: whisper needs uncompressed 16-bit PCM"
                    + " (this file says format " + format + ", " + bits + " bit).");
        }
        if (channels != 1) {
            return Optional.of("Unsupported WAV payload: whisper needs one channel"
                    + " (this file has " + channels + " channels).");
        }
        if (rate != REQUIRED_RATE) {
            return Optional.of("Unsupported sample rate " + rate + " Hz:"
                    + " whisper needs " + REQUIRED_RATE + " Hz.");
        }
        return Optional.empty();
    }

    /**
     * How long the recording runs, for the record that names it.
     *
     * @param audio a body that {@link #problem} accepted
     * @return seconds of audio, 0 when the file carries no samples
     */
    public static double seconds(byte[] audio) {
        int data = findChunk(ByteBuffer.wrap(audio).order(ByteOrder.LITTLE_ENDIAN), "data");
        if (data < 0) {
            return 0;
        }
        int size = Math.min(ByteBuffer.wrap(audio).order(ByteOrder.LITTLE_ENDIAN).getInt(data - 4),
                audio.length - data);
        return Math.max(0, size) / (double) (REQUIRED_RATE * 2);
    }

    /**
     * Where a chunk's payload starts, found by walking rather than assumed at a
     * fixed offset — a legitimate file that keeps a LIST or JUNK chunk first
     * must not be refused for where it puts its fields.
     *
     * @param buffer the whole file
     * @param wanted the four-character chunk id
     * @return the offset of the payload, or -1
     */
    private static int findChunk(ByteBuffer buffer, String wanted) {
        int at = FIRST_CHUNK;
        while (at + 8 <= buffer.capacity()) {
            String id = tag(buffer, at);
            int size = buffer.getInt(at + 4);
            if (id.equals(wanted)) {
                return at + 8;
            }
            if (size < 0) {
                return -1; // a size that does not fit an int is a broken file
            }
            at += 8 + size + (size % 2); // chunks are word aligned
        }
        return -1;
    }

    /** The four ASCII characters at {@code at}. */
    private static String tag(ByteBuffer buffer, int at) {
        if (at + 4 > buffer.capacity()) {
            return "";
        }
        byte[] four = new byte[4];
        buffer.duplicate().position(at).get(four);
        return new String(four, StandardCharsets.US_ASCII);
    }
}
