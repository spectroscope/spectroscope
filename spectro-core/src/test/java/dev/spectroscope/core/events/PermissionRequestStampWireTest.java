package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Card 399: {@code decidedBy} on {@code permission_request} is additive. An
 * unstamped request writes exactly the bytes it wrote before the field existed,
 * a stamped one adds the field and nothing else, and a line recorded before the
 * card reads back as an unstamped request.
 */
class PermissionRequestStampWireTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The line a pre-card-399 build wrote for this request, byte for byte. */
    private static final String BEFORE =
            "{\"type\":\"permission_request\",\"agentId\":\"main\",\"callId\":\"c2\","
                    + "\"name\":\"run_command\",\"input\":{\"command\":\"ls\"},\"ts\":5}";

    private static JsonNode input() {
        return JSON.createObjectNode().put("command", "ls");
    }

    @Test
    void anUnstampedRequestWritesTheBytesItAlwaysWrote() throws Exception {
        RunEvent request = new RunEvent.PermissionRequest("main", "c2", "run_command", input(), 5L);
        assertEquals(BEFORE, JSON.writeValueAsString(request));
        RunEvent explicitNull = new RunEvent.PermissionRequest("main", "c2", "run_command", input(), null, 5L);
        assertEquals(BEFORE, JSON.writeValueAsString(explicitNull));
    }

    @Test
    void aStampedRequestAddsTheFieldBeforeTsAndNothingElse() throws Exception {
        RunEvent request = new RunEvent.PermissionRequest("main", "c2", "run_command", input(),
                "mode:auto", 5L);
        assertEquals(BEFORE.replace(",\"ts\":5}", ",\"decidedBy\":\"mode:auto\",\"ts\":5}"),
                JSON.writeValueAsString(request));
    }

    @Test
    void aLineRecordedBeforeTheCardReadsBackUnstamped() throws Exception {
        RunEvent.PermissionRequest read =
                (RunEvent.PermissionRequest) JSON.readValue(BEFORE, RunEvent.class);
        assertNull(read.decidedBy());
        assertEquals("c2", read.callId());
    }

    @Test
    void aStampedLineRoundTrips() throws Exception {
        RunEvent request = new RunEvent.PermissionRequest("main", "c2", "run_command", input(),
                "allowlist", 5L);
        assertEquals(request, JSON.readValue(JSON.writeValueAsString(request), RunEvent.class));
    }
}
