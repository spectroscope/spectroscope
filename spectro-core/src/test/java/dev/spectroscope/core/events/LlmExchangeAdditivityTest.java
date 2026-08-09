package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 184 leg 3: the session JSONL learns what the socket already knew.
 *
 * <p>A finished backend-to-model exchange has been announced on the socket
 * since leg 2 and written into the session file never — so reopening a stored
 * session lost the fact that any model call had happened at all, and the
 * spectrum's second line could only ever exist for a session you were watching
 * live. The metadata is all measured (sizes, status, duration, the sidecar's own
 * xid); no field here is inferred, which is the constraint the card set for
 * making this record fatter.</p>
 *
 * <p>Additive on the card-72 precedent: a reader that has never heard of this
 * type must not die of it, and nothing about the existing lines may move.</p>
 */
class LlmExchangeAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private RunEvent.LlmExchange sample() {
        return new RunEvent.LlmExchange("x-1", "main", 3, "chat", "anthropic",
                "claude-opus-5", "sdk", "https://api.anthropic.com/v1/messages",
                200, 9162L, 4820L, 24, false, "sdk-json", 1704L, 42L);
    }

    @Test
    void itRoundTripsThroughTheWire() throws Exception {
        String line = JSON.writeValueAsString(sample());
        RunEvent.LlmExchange back = (RunEvent.LlmExchange) JSON.readValue(line, RunEvent.class);
        assertEquals(sample(), back, "the record is the contract; a lossy field is a lost fact");
        assertTrue(line.contains("\"type\":\"llm_exchange\""), line);
    }

    @Test
    void theXidIsWhatJoinsTheTwoProtocols() throws Exception {
        // The whole reason this event exists in the stream rather than only on a
        // socket: the sidecar's own xid travels with it, so a stored session can
        // be paired line-for-line with the file that holds the bodies.
        String line = JSON.writeValueAsString(sample());
        assertTrue(line.contains("\"xid\":\"x-1\""), line);
    }

    @Test
    void anOlderLineOfEveryOtherTypeStillParses() throws Exception {
        // Adding a subtype must not disturb the ones already on disk. The oldest
        // shape in the file is the one with the fewest fields.
        String old = "{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":5}";
        RunEvent.TurnStart start = (RunEvent.TurnStart) JSON.readValue(old, RunEvent.class);
        assertEquals(1, start.turn());
    }

    @Test
    void aReaderThatNeverHeardOfAnExchangeSurvivesTheFieldsItDoesNotKnow() throws Exception {
        // The other direction of the same promise, and the one `ignoreUnknown`
        // was turned on for: a NEWER writer may add a field to this line, and a
        // build from today must read the rest of it rather than die.
        String fromTheFuture = "{\"type\":\"llm_exchange\",\"xid\":\"x-9\",\"agentId\":\"main\","
                + "\"turn\":1,\"kind\":\"chat\",\"provider\":\"openai\",\"model\":\"gpt-5.4\","
                + "\"transport\":\"http\",\"url\":\"https://x/y\",\"status\":200,"
                + "\"requestBytes\":10,\"responseBytes\":20,\"responseLines\":2,"
                + "\"aborted\":false,\"fidelity\":\"bytes\",\"durationMs\":7,\"ts\":1,"
                + "\"somethingNobodyHasBuiltYet\":true}";
        RunEvent.LlmExchange read = (RunEvent.LlmExchange) JSON.readValue(fromTheFuture, RunEvent.class);
        assertEquals("x-9", read.xid());
        assertEquals("openai", read.provider());
    }

    @Test
    void anExchangeThatNeverAnsweredCarriesNoStatusRatherThanAZero() throws Exception {
        // A transport failure has no HTTP status, and 0 would be a claim about
        // something that never happened — the same rule the sidecar's own
        // response line already follows.
        RunEvent.LlmExchange dead = new RunEvent.LlmExchange("x-2", "main", 1, "chat",
                "openai", "gpt-5.4", "http", "https://x/y", null, 10L, 0L, 0, true,
                "bytes", 30L, 1L);
        RunEvent.LlmExchange back = (RunEvent.LlmExchange)
                JSON.readValue(JSON.writeValueAsString(dead), RunEvent.class);
        assertNull(back.status(), "no answer means no status, never a zero");
        assertTrue(back.aborted());
    }
}
