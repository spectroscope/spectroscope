package dev.spectroscope.server;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The hosted half of speech-to-text (card 187, the correction): no binary, no
 * model, no setup — a key and a POST.
 *
 * <p>The format claim this rests on was MEASURED, not assumed, before a line was
 * written: the API's own documentation lists wav among its input formats
 * ("Supported input formats are mp3, mp4, mpeg, mpga, m4a, wav, and webm"), and
 * the exact bytes step 5.4's browser encoder produces came back as 200 with the
 * right sentence. So {@code wavClip.ts} stays the only encoder and the same body
 * travels to either provider.</p>
 */
class HostedTranscriberTest {

    private static final byte[] AUDIO = VoiceFixtures.clip();

    @Test
    void buildsAMultipartBodyCarryingTheAudioVerbatim() {
        byte[] body = HostedTranscriber.multipart("BOUNDARY", AUDIO, "gpt-transcribe");
        String text = new String(body, StandardCharsets.ISO_8859_1);

        assertTrue(text.contains("--BOUNDARY\r\n"), text.substring(0, 120));
        assertTrue(text.contains("name=\"model\""));
        assertTrue(text.contains("gpt-transcribe"));
        assertTrue(text.contains("name=\"file\"; filename=\"recording.wav\""));
        assertTrue(text.contains("Content-Type: audio/wav"));
        assertTrue(text.endsWith("--BOUNDARY--\r\n"), "a multipart body ends with the closing boundary");

        // The audio rides byte for byte: find it back in the assembled body.
        assertTrue(indexOf(body, AUDIO) > 0, "the recording itself must be in there, unchanged");
    }

    @Test
    void readsTheTranscriptOutOfTheAnswer() {
        assertEquals("Hello Spectroscope, this is a voice wire test.",
                HostedTranscriber.textOf("{\"text\":\"Hello Spectroscope, this is a voice wire test.\"}"));
    }

    @Test
    void anEmptyOrTextlessAnswerIsEmptyRatherThanTheWholeJson() {
        // Silence transcribes to "", and a shape this build does not know must
        // never end up pasted into the composer as raw JSON.
        assertEquals("", HostedTranscriber.textOf("{\"text\":\"\"}"));
        assertEquals("", HostedTranscriber.textOf("{\"languages\":[{\"code\":\"en\"}]}"));
        assertEquals("", HostedTranscriber.textOf("not json at all"));
    }

    @Test
    void anApiErrorBecomesItsOwnSentenceAndNotAStackTrace() throws Exception {
        IOException failure = assertThrows(IOException.class, () -> HostedTranscriber.failureOf(
                401, "{\"error\":{\"message\":\"Incorrect API key provided: sk-abc\",\"code\":\"invalid_api_key\"}}"));

        assertTrue(failure.getMessage().contains("Incorrect API key provided"), failure.getMessage());
        assertTrue(failure.getMessage().contains("401"), failure.getMessage());
    }

    @Test
    void anErrorWithNoReadableBodyStillSaysTheStatus() {
        IOException failure = assertThrows(IOException.class,
                () -> HostedTranscriber.failureOf(503, "<html>upstream</html>"));

        assertTrue(failure.getMessage().contains("503"), failure.getMessage());
        assertFalse(failure.getMessage().contains("<html>"), "no markup in a sentence a person reads");
    }

    /** The endpoint the record names, and the reader recognises. */
    @Test
    void namesTheEndpointItReallyPosts() {
        assertEquals("https://api.openai.com/v1/audio/transcriptions", HostedTranscriber.URL);
    }

    private static int indexOf(byte[] haystack, byte[] needle) {
        outer:
        for (int i = 0; i <= haystack.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }
}
