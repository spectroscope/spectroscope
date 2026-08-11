package dev.spectroscope.core.graph;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The record that explains every absence in the payload file below it.
 *
 * <p>Its fields are the reason a missing channel can be read at all: without it,
 * "the node did not write it", "the policy denied it" and "the recorder failed"
 * are the same silence.</p>
 */
class StatePolicyTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void redactionIsAStringInEveryModeAndNeverABoolean() {
        for (StatePolicy policy : List.of(StatePolicy.off(), StatePolicy.summary(),
                StatePolicy.sample(), StatePolicy.full(true))) {
            Object redaction = StateRecords.statePolicy(policy, "r", 1L).get("redaction");
            assertTrue(redaction instanceof String, policy + " wrote " + redaction);
        }
        assertEquals("off", StateRecords.statePolicy(StatePolicy.off(), "r", 1L).get("redaction"));
        assertEquals("patterns",
                StateRecords.statePolicy(StatePolicy.summary(), "r", 1L).get("redaction"));
    }

    @Test
    void offCarriesNothingItCannotFillTruthfully() {
        Map<String, Object> record = StateRecords.statePolicy(StatePolicy.off(), "r7", 1L);

        assertEquals(List.of("type", "runId", "mode", "redaction", "ts"),
                new ArrayList<>(record.keySet()),
                "no allowed, no caps, no recordCap, no denied — an empty field is not written");
        assertEquals("off", record.get("mode"));
    }

    @Test
    void fullCarriesNoCapsAndNoRecordCap() {
        Map<String, Object> record = StateRecords.statePolicy(StatePolicy.full(true), "r", 1L);

        assertFalse(record.containsKey("caps"));
        assertFalse(record.containsKey("recordCap"));
        assertEquals("full", record.get("mode"));
    }

    @Test
    void fullIsUnreachableWithoutTheAcknowledgement() {
        GraphValidationException refusal =
                assertThrows(GraphValidationException.class, () -> StatePolicy.full(false));

        assertTrue(refusal.getMessage().contains("full(true)"), refusal.getMessage());
    }

    @Test
    void aCapReachesTheWireAsAnIntOrAThreeElementArray() throws Exception {
        String line = GraphJson.line(StateRecords.statePolicy(StatePolicy.summary(), "r", 1L));
        Map<?, ?> parsed = JSON.readValue(line, Map.class);
        Map<?, ?> caps = (Map<?, ?>) parsed.get("caps");

        assertEquals(4096, caps.get("question"));
        assertEquals(List.of("sample", 3, 512), caps.get("docs"));
    }

    @Test
    void aChannelWithNoCapLeavesTheCapTableAndJoinsTheDenied() {
        LinkedHashMap<String, StatePolicy.Cap> table = new LinkedHashMap<>();
        table.put("secret", null);
        StatePolicy policy = StatePolicy.sample().withCaps(table);

        assertFalse(policy.caps().containsKey("secret"),
                "a denied channel shown with a cap would read as recordable");
        assertTrue(policy.denied().contains("secret"));
    }

    @Test
    void theGateIsAllowedBeatsDeniedBeatsMode() {
        assertFalse(StatePolicy.summary().recordsChannel("notes"),
                "summary is a named-channels tier: unknown words get nothing");
        assertTrue(StatePolicy.summary().recordsChannel("answer"));
        assertFalse(StatePolicy.sample().recordsChannel("principal"));
        assertTrue(StatePolicy.full(true).withAllowed(List.of("principal"))
                .recordsChannel("principal"));
        assertFalse(StatePolicy.full(true).recordsChannel("principal"));
        assertFalse(StatePolicy.off().recordsChannel("answer"));
    }
}
