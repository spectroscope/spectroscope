package dev.spectroscope.core.trace;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Pins the trace id a session gets in the exported OTLP batch (card 137).
 *
 *  <p>The browser computes the same value to build the "open in langfuse"
 *  deep link, in {@code spectro-web/src/observability/langfuseLink.ts}. That
 *  TypeScript test asserts the SAME literal, so drift on either side turns
 *  both red. Do not relax the literal here without changing it there.</p> */
class OtlpTraceIdPinTest {

    /** Measured against a live Langfuse instance on 2026-07-30: session
     *  20260726-172215 landed under exactly this trace id. */
    private static final String PINNED = "029564610f262b63fd5b47c64f54cda7";

    @Test
    void traceIdIsSha256OfTheSessionSeed() {
        assertEquals(PINNED, OtlpSink.traceIdFor("20260726-172215"));
    }

    @Test
    void traceIdIsThirtyTwoLowercaseHex() {
        String id = OtlpSink.traceIdFor("some-other-session");
        assertTrue(id.matches("[0-9a-f]{32}"), "not 32 lowercase hex chars: " + id);
    }
}
