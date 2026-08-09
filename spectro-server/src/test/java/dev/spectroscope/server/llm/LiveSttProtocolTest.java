package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.Base64;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The realtime transcription handshake, pinned to what the API actually does.
 *
 * <p>Every constant below was learned on 2026-08-09 by being REFUSED, not by
 * reading a page: the beta header is gone, GA wants {@code intent=transcription},
 * a transcription model may not be the session model, the rate floor is 24 kHz,
 * and {@code gpt-live-transcribe} rejects turn detection outright. A test is the
 * only place those five facts survive the next person's reasonable guess.</p>
 */
class LiveSttProtocolTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private JsonNode parse(String raw) {
        try {
            return JSON.readTree(raw);
        } catch (Exception broken) {
            throw new IllegalStateException("not json: " + raw, broken);
        }
    }

    @Test
    void theSessionUrlAsksForTranscriptionAndCarriesNoModel() {
        // ?model=gpt-live-transcribe came back invalid_model: "is a transcription
        // model and cannot be used as the realtime session model". The session we
        // want has no conversation model at all, which is what intent= selects.
        assertEquals("wss://api.openai.com/v1/realtime?intent=transcription",
                LiveSttProtocol.URL);
        assertFalse(LiveSttProtocol.URL.contains("model="),
                "a model in the query makes this a conversation session");
    }

    @Test
    void theHandshakeAsksForTwentyFourKilohertzBecauseSixteenIsRefused() {
        // rate 16000 -> integer_below_min_value, "Expected a value >= 24000".
        // The refusal lands after someone has already spoken, so the number is
        // pinned here rather than discovered in front of a user.
        JsonNode update = parse(LiveSttProtocol.sessionUpdate("gpt-live-transcribe"));
        JsonNode input = update.path("session").path("audio").path("input");
        assertEquals("transcription", update.path("session").path("type").asText());
        assertEquals(24_000, input.path("format").path("rate").asInt());
        assertEquals("audio/pcm", input.path("format").path("type").asText());
        assertEquals("gpt-live-transcribe", input.path("transcription").path("model").asText());
    }

    @Test
    void theHandshakeAsksForNoTurnDetectionAtAll() {
        // "Turn detection is not supported for this transcription model." Sending
        // it is not a warning, it is an error frame that ends the session before
        // a single sample is appended.
        JsonNode input = parse(LiveSttProtocol.sessionUpdate("gpt-live-transcribe"))
                .path("session").path("audio").path("input");
        assertTrue(input.path("turn_detection").isMissingNode(),
                "the model refuses the field, so it must not be in the frame");
    }

    @Test
    void anAppendCarriesTheBase64Untouched() {
        // The browser already encoded PCM16; re-encoding it here would be a
        // second interpretation of the same bytes and a place to get endianness
        // wrong twice.
        String audio = Base64.getEncoder().encodeToString(new byte[] {1, 2, 3, 4});
        JsonNode frame = parse(LiveSttProtocol.append(audio));
        assertEquals("input_audio_buffer.append", frame.path("type").asText());
        assertEquals(audio, frame.path("audio").asText());
    }

    @Test
    void anEmptyAppendIsRefusedBeforeItReachesTheSocket() {
        // A frame with no audio in it is pure overhead on a live socket, and the
        // far side counts it against the buffer either way.
        assertThrows(IllegalArgumentException.class, () -> LiveSttProtocol.append(""));
    }

    @Test
    void aDeltaReadsAsAPartialAndCarriesItsText() {
        LiveSttProtocol.Incoming read = LiveSttProtocol.read(parse("""
                {"type":"conversation.item.input_audio_transcription.delta","delta":" spectroscope"}
                """));
        assertEquals(LiveSttProtocol.Kind.PARTIAL, read.kind());
        assertEquals(" spectroscope", read.text());
    }

    @Test
    void theCompletedEventIsTheFinalTextAndReplacesEveryPartial() {
        LiveSttProtocol.Incoming read = LiveSttProtocol.read(parse("""
                {"type":"conversation.item.input_audio_transcription.completed",
                 "transcript":"This is the whole sentence."}
                """));
        assertEquals(LiveSttProtocol.Kind.FINAL, read.kind());
        assertEquals("This is the whole sentence.", read.text());
    }

    @Test
    void anErrorFrameIsAnErrorAndNotAnEmptyTranscript() {
        // The failure mode this closes: reading the message field of an error as
        // if it were text would type the API's complaint into the composer.
        LiveSttProtocol.Incoming read = LiveSttProtocol.read(parse("""
                {"type":"error","error":{"code":"invalid_value","message":"Turn detection is not supported"}}
                """));
        assertEquals(LiveSttProtocol.Kind.ERROR, read.kind());
        assertTrue(read.text().contains("Turn detection"));
    }

    @Test
    void theSessionUpdateAcknowledgementIsWhatUnblocksTheAudio() {
        // Appending before session.updated arrives means the samples are graded
        // against whatever the session defaulted to. The handler waits for this.
        assertEquals(LiveSttProtocol.Kind.READY,
                LiveSttProtocol.read(parse("{\"type\":\"session.updated\"}")).kind());
    }

    @Test
    void everythingElseIsIgnoredRatherThanGuessedAt() {
        // session.created, input_audio_buffer.committed, conversation.item.added,
        // conversation.item.done: real events with nothing for a composer in them.
        for (String type : new String[] {"session.created", "input_audio_buffer.committed",
                "conversation.item.added", "conversation.item.done", "rate_limits.updated"}) {
            LiveSttProtocol.Incoming read =
                    LiveSttProtocol.read(parse("{\"type\":\"" + type + "\"}"));
            assertEquals(LiveSttProtocol.Kind.IGNORE, read.kind(), type);
        }
    }

    @Test
    void aFrameWithNoTypeIsIgnoredInsteadOfThrowing() {
        // A socket that dies on an unexpected frame takes the recording with it.
        assertEquals(LiveSttProtocol.Kind.IGNORE, LiveSttProtocol.read(parse("{}")).kind());
        assertNull(LiveSttProtocol.read(parse("{}")).text());
    }
}
