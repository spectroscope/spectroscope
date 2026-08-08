package dev.spectroscope.cli.voice;

import org.junit.jupiter.api.Test;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * whisper.cpp reads exactly one thing: 16 kHz mono 16-bit PCM. Nothing used to
 * check that — ffmpeg produced it, so it was true by construction. Now the
 * browser produces it, and "true by construction" became "true if the client is
 * the one we think it is".
 *
 * <p>The reason this check exists rather than trusting the caller is on the
 * record: card 184 found a Content-Type-less POST whose audio the form parser
 * chewed up, ffmpeg fail, its exit code get ignored, and whisper's HELP TEXT
 * come back as a 200 "transcript". A wrong container must be a sentence, not a
 * plausible-looking answer.</p>
 */
class WavAudioTest {

    /** A minimal WAV header with whatever fields the case needs. */
    private static byte[] wav(int format, int channels, int sampleRate, int dataBytes) {
        ByteBuffer buffer = ByteBuffer.allocate(44 + dataBytes).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(36 + dataBytes);
        buffer.put("WAVE".getBytes(StandardCharsets.US_ASCII));
        buffer.put("fmt ".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(16);
        buffer.putShort((short) format);
        buffer.putShort((short) channels);
        buffer.putInt(sampleRate);
        buffer.putInt(sampleRate * channels * 2);
        buffer.putShort((short) (channels * 2));
        buffer.putShort((short) 16);
        buffer.put("data".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(dataBytes);
        return buffer.array();
    }

    private static byte[] good() {
        return wav(1, 1, 16000, 3200);
    }

    @Test
    void whatTheBrowserSendsPasses() {
        assertEquals(Optional.empty(), WavAudio.problem(good()));
    }

    @Test
    void aContainerThatIsNotAWavIsNamedAsSuch() {
        // Exactly what arrived before this leg: the recorder's own webm/opus.
        byte[] webm = {0x1A, 0x45, (byte) 0xDF, (byte) 0xA3, 0, 0, 0, 0, 0, 0, 0, 0};

        Optional<String> problem = WavAudio.problem(webm);

        assertTrue(problem.isPresent());
        assertTrue(problem.get().contains("WAV"), problem.get());
    }

    @Test
    void theWrongSampleRateIsNamedWithBothNumbers() {
        Optional<String> problem = WavAudio.problem(wav(1, 1, 44100, 800));

        assertTrue(problem.isPresent());
        assertTrue(problem.get().contains("44100"), problem.get());
        assertTrue(problem.get().contains("16000"), problem.get());
    }

    @Test
    void stereoIsNamedRatherThanSilentlyHalfTranscribed() {
        Optional<String> problem = WavAudio.problem(wav(1, 2, 16000, 800));

        assertTrue(problem.isPresent());
        assertTrue(problem.get().toLowerCase().contains("channel"), problem.get());
    }

    @Test
    void aCompressedOrFloatPayloadIsRefusedEvenThoughTheHeaderLooksRight() {
        Optional<String> problem = WavAudio.problem(wav(3, 1, 16000, 800)); // 3 = IEEE float

        assertTrue(problem.isPresent());
        assertTrue(problem.get().contains("PCM"), problem.get());
    }

    @Test
    void aTruncatedFileIsARefusalAndNeverAnIndexOutOfBounds() {
        byte[] head = new byte[20];
        System.arraycopy(good(), 0, head, 0, 20);

        Optional<String> problem = WavAudio.problem(head);

        assertTrue(problem.isPresent(), "a half-arrived upload must be readable, not a stack trace");
    }

    @Test
    void anEmptyBodyIsRefusedBeforeAnythingIsSpawned() {
        assertTrue(WavAudio.problem(new byte[0]).isPresent());
    }

    @Test
    void aChunkBeforeFmtDoesNotHideIt() {
        // Some encoders put LIST or JUNK first. The fmt chunk is found by walking,
        // so a legitimate file is never refused for where it keeps its fields.
        byte[] plain = good();
        ByteBuffer buffer = ByteBuffer.allocate(plain.length + 12).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put(plain, 0, 12); // RIFF/size/WAVE
        buffer.put("JUNK".getBytes(StandardCharsets.US_ASCII));
        buffer.putInt(4);
        buffer.putInt(0);
        buffer.put(plain, 12, plain.length - 12);

        assertEquals(Optional.empty(), WavAudio.problem(buffer.array()));
    }

    @Test
    void secondsAreReadOffTheHeaderSoTheRecordCanSayHowLongItWas() {
        // 3200 bytes of 16 kHz 16 bit mono is a tenth of a second.
        assertEquals(0.1, WavAudio.seconds(good()), 0.0001);
    }
}
