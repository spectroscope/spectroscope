package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 263: {@code context_info} says which fact produced its threshold, and
 * says it ADDITIVELY.
 *
 * <p>Every sibling additive component in this wave shipped one of these
 * (QuestionAdditivityTest, RunEndVerdictAdditivityTest,
 * ToolResultFileChangeAdditivityTest, ImagesWithheldAdditivityTest); this one
 * was missed, so the card's claim — "dropped from the wire when null so old
 * sessions replay unchanged" — was pinned by nothing at all. Removing
 * {@code @JsonInclude(NON_NULL)} or the pre-263 constructor went unnoticed by
 * the whole suite.</p>
 */
class ContextInfoThresholdSourceAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static List<RunEvent.ContextPart> parts() {
        return List.of(new RunEvent.ContextPart("system prompt", 400, 100, "you are…"));
    }

    @Test
    void theSourceRidesTheWireWhenThereIsOne() throws Exception {
        String line = JSON.writeValueAsString(new RunEvent.ContextInfo(
                "main", 1, 4, 43_000, 153_216, parts(), 99L, "window"));

        assertTrue(line.contains("\"thresholdSource\":\"window\""), line);

        RunEvent.ContextInfo back = (RunEvent.ContextInfo) JSON.readValue(line, RunEvent.class);
        assertEquals("window", back.thresholdSource());
        assertEquals(153_216, back.threshold());
    }

    @Test
    void theOldShapeDoesNotGrowAKey() throws Exception {
        // The pre-263 constructor is the whole compatibility story: a caller
        // that never heard of provenance must serialize byte-for-byte as before,
        // which means the key is ABSENT and not null.
        String line = JSON.writeValueAsString(new RunEvent.ContextInfo(
                "main", 1, 4, 43_000, 100_000, parts(), 99L));

        assertFalse(line.contains("thresholdSource"), line);
        assertNull(((RunEvent.ContextInfo) JSON.readValue(line, RunEvent.class))
                .thresholdSource());
    }

    @Test
    void aSessionRecordedBeforeThisCardStillReplays() throws Exception {
        // A real pre-263 line, as the sessions on this machine carry it.
        String old = "{\"type\":\"context_info\",\"agentId\":\"main\",\"turn\":3,"
                + "\"messages\":8,\"estimatedTokens\":43012,\"threshold\":100000,"
                + "\"parts\":[{\"label\":\"system prompt\",\"chars\":400,\"estTokens\":100}],"
                + "\"ts\":1755000000000}";

        RunEvent.ContextInfo back = (RunEvent.ContextInfo) JSON.readValue(old, RunEvent.class);

        assertNull(back.thresholdSource(), "an old line states no provenance, and may not invent one");
        assertEquals(3, back.turn());
        assertEquals(8, back.messages());
        assertEquals(43_012, back.estimatedTokens());
        assertEquals(100_000, back.threshold());
        assertEquals(1, back.parts().size());
        assertEquals("system prompt", back.parts().getFirst().label());
        assertEquals(1_755_000_000_000L, back.ts());
    }

    @Test
    void aReaderSurvivesAProvenanceItHasNeverHeardOf() throws Exception {
        // The enum may grow a fourth source; a reader from today must not choke.
        String fromTheFuture = "{\"type\":\"context_info\",\"agentId\":\"main\",\"turn\":1,"
                + "\"messages\":2,\"estimatedTokens\":10,\"threshold\":6144,\"parts\":[],"
                + "\"ts\":1,\"thresholdSource\":\"tokenizer\",\"reserve\":2048}";

        RunEvent.ContextInfo back =
                (RunEvent.ContextInfo) JSON.readValue(fromTheFuture, RunEvent.class);

        assertEquals("tokenizer", back.thresholdSource());
        assertEquals(6_144, back.threshold());
    }
}
