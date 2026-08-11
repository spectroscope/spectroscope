package dev.spectroscope.core.graph;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What one node put on disk, and what happened to everything it did not.
 *
 * <p>The rule the whole layer exists for: a truncated value is never a shorter
 * value of the same type. Every ceiling replaces the value with a marker naming
 * which ceiling fired and carrying the true size of what it stands for — a
 * shortened string that still looks whole is the one failure this prevents.</p>
 */
class StatePayloadTest {

    private static Map<String, Object> update(Object... pairs) {
        LinkedHashMap<String, Object> written = new LinkedHashMap<>();
        for (int index = 0; index < pairs.length; index += 2) {
            written.put((String) pairs[index], pairs[index + 1]);
        }
        return written;
    }

    private static StatePolicy capped(String channel, StatePolicy.Cap cap) {
        LinkedHashMap<String, StatePolicy.Cap> table = new LinkedHashMap<>();
        table.put(channel, cap);
        return StatePolicy.sample().withCaps(table);
    }

    private static Map<String, Object> build(Map<String, Object> written, StatePolicy policy) {
        return StateRecords.statePayload("n", 1, written, policy, "r", 7L);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> channel(Map<String, Object> record, String name) {
        return (Map<String, Object>) ((Map<String, Object>) record.get("channels")).get(name);
    }

    // -- the envelope -------------------------------------------------------- //

    @Test
    void theRecordCarriesTypeFirstAndTsLast() {
        Map<String, Object> record = build(update("x", 1), StatePolicy.sample());

        assertEquals(List.of("type", "runId", "node", "superstep", "channels", "ts"),
                new ArrayList<>(record.keySet()));
        assertEquals(7L, record.get("ts"), "a caller-supplied ts is preserved verbatim");
    }

    @Test
    void channelKeyOrderIsTheNodesOwnWriteOrder() {
        Map<String, Object> record = build(update("zebra", 1, "alpha", 2), StatePolicy.sample());

        assertEquals(List.of("zebra", "alpha"),
                new ArrayList<>(((Map<?, ?>) record.get("channels")).keySet()));
    }

    @Test
    void truncatedIsOmittedWhenNothingWasTruncated() {
        Map<String, Object> record = build(update("x", "short"), StatePolicy.sample());

        assertFalse(record.containsKey("truncated"),
                "an empty array would badge every clean row in a viewer that checks for the key");
    }

    @Test
    void aNullChannelSurvivesAsNullRatherThanBeingOmitted() {
        Map<String, Object> record = build(update("x", null), StatePolicy.sample());

        Map<?, ?> channels = (Map<?, ?>) record.get("channels");
        assertTrue(channels.containsKey("x"), "'wrote null' is not 'not recorded'");
        assertNull(channels.get("x"));
        assertEquals("{\"type\":\"state_payload\",\"runId\":\"r\",\"node\":\"n\",\"superstep\":1,"
                + "\"channels\":{\"x\":null},\"ts\":7}", GraphJson.line(record));
    }

    // -- when no line is written --------------------------------------------- //

    @Test
    void recordingOffWritesNoLineAtAll() {
        assertNull(StateRecords.statePayload("n", 1, update("x", 1), StatePolicy.off(), "r", 7L));
        assertNull(StateRecords.statePayload("n", 1, update("x", 1), null, "r", 7L));
    }

    @Test
    void aNodeWhoseEveryChannelIsDeniedGetsNoLineRatherThanAnEmptyOne() {
        assertNull(build(update("principal", "alice"), StatePolicy.sample()),
                "empty channels would read as 'the node wrote nothing', a different fact");
    }

    @Test
    void anEmptyUpdateNeverReachesTheBuilder() {
        assertNull(build(update(), StatePolicy.sample()));
    }

    // -- the five markers ----------------------------------------------------- //

    @Test
    void aClippedStringBecomesAMarkerCarryingItsTrueSize() {
        String value = "A".repeat(5000);
        Map<String, Object> record = build(update("x", value), capped("x", new StatePolicy.ByteCap(512)));

        assertEquals(Map.of("kind", "str", "bytes", 5000, "chars", 5000,
                "omitted", "cap", "head", "A".repeat(512)), channel(record, "x"));
        assertEquals(List.of("x"), record.get("truncated"));
    }

    @Test
    void theHeadIsAByteExactPrefixWithAHalfWrittenCharacterDropped() {
        String value = "ü".repeat(100);
        Map<String, Object> record = build(update("x", value), capped("x", new StatePolicy.ByteCap(9)));
        Map<String, Object> marker = channel(record, "x");

        assertEquals("üüüü", marker.get("head"), "nine bytes is four whole umlauts and half of a fifth");
        assertEquals(200, marker.get("bytes"));
        assertEquals(100, marker.get("chars"), "code points, not UTF-16 units");
        assertTrue(value.startsWith((String) marker.get("head")));
        assertFalse(((String) marker.get("head")).contains("…"), "no ellipsis is appended");
    }

    @Test
    void charsCountsCodePointsSoAnAstralCharacterDoesNotDouble() {
        String value = "🔭".repeat(50);
        Map<String, Object> record = build(update("x", value), capped("x", new StatePolicy.ByteCap(8)));

        assertEquals(50, channel(record, "x").get("chars"),
                "String.length() would say 100 and the number would be wrong for exactly the "
                        + "corpus most likely to need clipping");
        assertEquals(200, channel(record, "x").get("bytes"));
    }

    @Test
    void aSampledListKeepsItsLeadingSliceInTheNodesOwnOrder() {
        List<Map<String, Object>> docs = new ArrayList<>();
        for (int ordinal = 0; ordinal < 8; ordinal++) {
            docs.add(update("ordinal", ordinal));
        }
        Map<String, Object> record =
                build(update("docs", docs), capped("docs", new StatePolicy.SampleCap(3, 512)));
        Map<String, Object> marker = channel(record, "docs");

        assertEquals("list", marker.get("kind"));
        assertEquals(8, marker.get("len"), "the TRUE element count stays on the marker");
        assertEquals(3, marker.get("sampled"));
        List<?> items = (List<?>) marker.get("items");
        assertEquals(List.of(0, 1, 2), items.stream().map(item -> ((Map<?, ?>) item).get("ordinal"))
                .toList(), "the leading slice, never a 'best' selection");
        assertEquals(GraphJson.utf8Bytes(docs), marker.get("bytes"));
    }

    @Test
    void aSampleCapAlsoBitesAtEveryDepthOfItsChannel() {
        Map<String, Object> document = update("tags", List.of("a", "b", "c", "d", "e"));
        Map<String, Object> record = build(update("docs", List.of(document)),
                capped("docs", new StatePolicy.SampleCap(3, 512)));

        Object nested = ((Map<?, ?>) ((List<?>) ((Map<?, ?>) record.get("channels")).get("docs"))
                .get(0)).get("tags");
        assertEquals("list", ((Map<?, ?>) nested).get("kind"),
                "a cap that only bites at the first level records more than it promised");
    }

    @Test
    void aStringInWhichAPatternFiresIsReplacedWholeAndSizedByBucket() {
        String document = "prose ".repeat(600) + "sk-proj-AbCdEf0123456789XyZwVu" + " more prose";
        Map<String, Object> record = build(update("x", document), StatePolicy.sample());

        assertEquals(Map.of("kind", "redacted", "rule", "openai-key", "bytes", "129+"),
                channel(record, "x"));
        assertFalse(GraphJson.line(record).contains("prose"),
                "prose surviving beside a marker invites 'the rest is fine'");
        assertTrue(channel(record, "x").get("bytes") instanceof String,
                "an exact length is a small oracle");
    }

    @Test
    void redactionRunsBeforeClippingSoAHeadCannotEndMidCredential() {
        String value = "token sk-proj-AbCdEf0123456789XyZwVu" + "!".repeat(5000);
        Map<String, Object> record = build(update("x", value), capped("x", new StatePolicy.ByteCap(64)));

        assertEquals("redacted", channel(record, "x").get("kind"));
    }

    @Test
    void aValueThatCannotBeDescribedSaysSoInsteadOfVanishing() {
        Map<String, Object> record = build(update("confidence", Double.NaN), StatePolicy.sample());

        assertEquals(Map.of("kind", "unserializable", "type", "Double", "omitted", "error"),
                channel(record, "confidence"));
        assertFalse(GraphJson.line(record).contains("NaN"),
                "a bare NaN token is not JSON and a strict reader rejects the whole line");
    }

    @Test
    void aCycleBecomesAMarkerRatherThanAStackOverflow() {
        List<Object> looping = new ArrayList<>();
        looping.add(looping);
        Map<String, Object> record = build(update("x", looping), StatePolicy.sample());

        assertNotNull(record);
        assertEquals("unserializable",
                ((Map<?, ?>) ((List<?>) channelValue(record, "x")).get(0)).get("kind"));
    }

    private static Object channelValue(Map<String, Object> record, String name) {
        return ((Map<?, ?>) record.get("channels")).get(name);
    }

    // -- the last-resort ceiling ---------------------------------------------- //

    @Test
    void anOverLongRecordCollapsesEveryChannelAndStillNamesThemAll() {
        List<String> trace = new ArrayList<>();
        for (int index = 0; index < 40; index++) {
            trace.add("t".repeat(900));
        }
        Map<String, Object> written = update("trace", trace, "confidence", 0.82);
        Map<String, Object> record = build(written, StatePolicy.sample());

        assertEquals(Map.of("kind", "channel", "bytes", GraphJson.utf8Bytes(trace),
                "omitted", "recordCap"), channel(record, "trace"));
        assertEquals(Map.of("kind", "channel", "bytes", 4, "omitted", "recordCap"),
                channel(record, "confidence"));
        assertEquals(List.of("trace", "confidence"), record.get("truncated"));
        assertTrue(GraphJson.line(record).length() < StatePolicy.RECORD_CAP);
    }

    @Test
    void theCallersOwnUpdateIsNeverMutated() {
        Map<String, Object> written = update("x", "A".repeat(5000));
        build(written, capped("x", new StatePolicy.ByteCap(512)));

        assertEquals(5000, ((String) written.get("x")).length());
    }
}
