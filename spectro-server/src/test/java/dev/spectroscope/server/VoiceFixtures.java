package dev.spectroscope.server;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * What the browser posts to {@code /api/transcribe} since card 187 step 5.4:
 * a finished 16 kHz mono WAV, converted in the page that recorded it. Before
 * that leg the body was webm/opus and the server ran ffmpeg on it.
 */
final class VoiceFixtures {

    private VoiceFixtures() {
    }

    /**
     * A valid, silent 16 kHz mono 16-bit WAV.
     *
     * @param samples how many frames of silence to carry
     * @return the complete file, header included
     */
    static byte[] wav16k(int samples) {
        int dataBytes = samples * 2;
        ByteBuffer buffer = ByteBuffer.allocate(44 + dataBytes).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(36 + dataBytes);
        buffer.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        buffer.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(16);
        buffer.putShort((short) 1); // PCM
        buffer.putShort((short) 1); // mono
        buffer.putInt(16000);
        buffer.putInt(32000);
        buffer.putShort((short) 2);
        buffer.putShort((short) 16);
        buffer.put("data".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(dataBytes);
        return buffer.array();
    }

    /** A short clip — enough to be a real body without being a big one. */
    static byte[] clip() {
        return wav16k(1600); // a tenth of a second
    }
}
