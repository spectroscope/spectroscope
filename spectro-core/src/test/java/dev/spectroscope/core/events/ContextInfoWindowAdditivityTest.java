package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 366, AC 6: {@code context_info} carries the WINDOW the threshold was
 * measured against, and carries it additively — the way card 263 added
 * {@code thresholdSource} and for the same reason.
 *
 * <p>Without it the gauge shows a denominator with no stated origin: "24.1k of
 * 188k before compaction" is a number the operator cannot check, and the web's
 * answer for two months was a hand-typed vendor prefix table that returned null
 * for every local model — so the line naming the window never rendered on the
 * backend the owner actually tests with.</p>
 */
class ContextInfoWindowAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static List<RunEvent.ContextPart> parts() {
        return List.of(new RunEvent.ContextPart("system prompt", 400, 100, "you are…"));
    }

    @Test
    void theWindowRidesTheWireWhenTheRunKnowsOne() throws Exception {
        // The owner's own loaded instance: 250,368 tokens, 70 % of it is 175,257.
        String line = JSON.writeValueAsString(new RunEvent.ContextInfo(
                "main", 1, 4, 43_000, 175_257, parts(), 99L, "window", 250_368));

        assertTrue(line.contains("\"contextWindow\":250368"), line);

        RunEvent.ContextInfo back = (RunEvent.ContextInfo) JSON.readValue(line, RunEvent.class);
        assertEquals(250_368, back.contextWindow());
        assertEquals(175_257, back.threshold());
        assertEquals("window", back.thresholdSource());
    }

    @Test
    void theCloudShapeCarriesThePublishedWindowAndSaysWhereItCameFrom() throws Exception {
        // The case the card was written for: no loaded instance to overrun, a
        // published million, and a threshold seven times the old constant.
        String line = JSON.writeValueAsString(new RunEvent.ContextInfo(
                "main", 1, 4, 43_000, 700_000, parts(), 99L, "model", 1_000_000));

        RunEvent.ContextInfo back = (RunEvent.ContextInfo) JSON.readValue(line, RunEvent.class);
        assertEquals("model", back.thresholdSource());
        assertEquals(1_000_000, back.contextWindow());
        assertEquals(700_000, back.threshold());
    }

    @Test
    void theOlderShapesDoNotGrowAKey() throws Exception {
        // Both pre-366 constructors are the compatibility story: a caller that
        // never heard of the window must serialize byte-for-byte as before,
        // which means the key is ABSENT and not null. A zero would be worse than
        // absent — it is a claim ("no room") in a field whose whole job is
        // saying how much room there is.
        String withSource = JSON.writeValueAsString(new RunEvent.ContextInfo(
                "main", 1, 4, 43_000, 100_000, parts(), 99L, "fallback"));
        String pre263 = JSON.writeValueAsString(new RunEvent.ContextInfo(
                "main", 1, 4, 43_000, 100_000, parts(), 99L));

        assertFalse(withSource.contains("contextWindow"), withSource);
        assertFalse(pre263.contains("contextWindow"), pre263);
        assertNull(((RunEvent.ContextInfo) JSON.readValue(withSource, RunEvent.class))
                .contextWindow());
        assertNull(((RunEvent.ContextInfo) JSON.readValue(pre263, RunEvent.class))
                .contextWindow());
    }

    @Test
    void aSessionRecordedBeforeThisCardStillReplays() throws Exception {
        // A real pre-366 line, as the sessions on this machine carry it: the
        // provenance is there, the window is not.
        String old = "{\"type\":\"context_info\",\"agentId\":\"main\",\"turn\":3,"
                + "\"messages\":8,\"estimatedTokens\":43012,\"threshold\":153216,"
                + "\"parts\":[{\"label\":\"system prompt\",\"chars\":400,\"estTokens\":100}],"
                + "\"ts\":1755000000000,\"thresholdSource\":\"window\"}";

        RunEvent.ContextInfo back = (RunEvent.ContextInfo) JSON.readValue(old, RunEvent.class);

        assertNull(back.contextWindow(), "an old line states no window, and may not invent one");
        assertEquals("window", back.thresholdSource());
        assertEquals(153_216, back.threshold());
        assertEquals(1_755_000_000_000L, back.ts());
    }
}
