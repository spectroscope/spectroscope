package dev.spectroscope.server.observability;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.wire.LlmWireRecorder;
import dev.spectroscope.core.wire.LlmWireTap;
import dev.spectroscope.core.wire.LlmWireTap.WireOutcome;
import dev.spectroscope.core.wire.LlmWireTap.WireRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 434: {@code GET /api/sessions/{id}/llm-wire/index} reads only what it
 * returns. Every answer here is compared with {@link LlmWireIndexOracle}, the
 * index as 0.13.0 built it, serialized to JSON so key order and null against
 * absent count as well. The Gradle test task points {@code user.home} into the
 * build directory, so the sidecars written here never touch a real home.
 */
class LlmWireIndexTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final LlmWireController controller = new LlmWireController();

    private static String freshId() {
        return "test-index-" + UUID.randomUUID().toString().substring(0, 8);
    }

    private static Path sidecar(String id) {
        return LlmWireRecorder.fileFor(id);
    }

    private static void write(String id, byte[] bytes) throws IOException {
        Files.createDirectories(sidecar(id).getParent());
        Files.write(sidecar(id), bytes);
    }

    private static void append(String id, byte[] bytes) throws IOException {
        Files.write(sidecar(id), bytes, StandardOpenOption.APPEND);
    }

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.writeBytes(part);
        }
        return out.toByteArray();
    }

    /** Writes through the real recorder with the given byte ceiling. */
    private static void recorded(String id, long ceiling, Consumer<LlmWireRecorder> script) {
        try (LlmWireRecorder recorder = new LlmWireRecorder(sidecar(id), ceiling)) {
            script.accept(recorder);
        }
    }

    private static WireRequest request(String body, long ts) {
        return new WireRequest("anthropic", "claude-sonnet-5", "http", "POST",
                "https://api.anthropic.com/v1/messages",
                Map.of("x-api-key", "sk-secret", "content-type", "application/json"),
                "bytes", body, ts);
    }

    private List<Map<String, Object>> served(String id) {
        ResponseEntity<List<Map<String, Object>>> res = controller.index(id, new MockHttpServletRequest());
        assertEquals(200, res.getStatusCode().value(), "the index answers 200 for " + id);
        return res.getBody();
    }

    private static String json(Object value) throws IOException {
        return JSON.writeValueAsString(value);
    }

    // ---- 1. the memory the index allocates ---------------------------------

    @Test
    void indexingASidecarAllocatesLessThanAQuarterOfTheBodiesItSkips() throws Exception {
        String id = freshId();
        String body = "x".repeat(1 << 20);
        recorded(id, LlmWireRecorder.DEFAULT_CEILING_BYTES, recorder -> {
            LlmWireTap.Exchange exchange = recorder.bound("main", 1).begin(request(body, 1000L));
            String streamLine = "data: " + "y".repeat(1018);
            for (int i = 0; i < 1024; i++) {
                exchange.line(streamLine);
            }
            exchange.end(new WireOutcome(200, "bytes", null, false, null, 1600L));
        });
        long skipped = 2L << 20;

        com.sun.management.ThreadMXBean threads =
                (com.sun.management.ThreadMXBean) ManagementFactory.getThreadMXBean();
        assertTrue(threads.isThreadAllocatedMemorySupported() && threads.isThreadAllocatedMemoryEnabled(),
                "this JVM counts the bytes a thread allocates");
        served(id); // loads the classes the call uses, so the counted calls count only the call
        long least = Long.MAX_VALUE;
        for (int round = 0; round < 3; round++) {
            long before = threads.getCurrentThreadAllocatedBytes();
            List<Map<String, Object>> index = served(id);
            long allocated = threads.getCurrentThreadAllocatedBytes() - before;
            least = Math.min(least, allocated);
            assertEquals(1, index.size());
            assertEquals(1024, index.get(0).get("responseLines"));
        }
        System.out.println("card 434: indexing " + skipped + " bytes of bodies and stream lines allocated "
                + least + " bytes in the smallest of three calls");
        assertTrue(least < skipped / 4,
                "indexing " + skipped + " bytes of bodies and stream lines allocated " + least
                        + " bytes in the smallest of three calls; the bound is " + (skipped / 4));
    }

    /**
     * A live session's sidecar can end in a line cut off mid-write. Such a
     * line fails to parse like the old index's did and is dropped, and it is
     * not read again as one String on the way: only a line on which the byte
     * parser hits one of Jackson's stream limits is.
     */
    @Test
    void aTornTailLineIsDroppedWithoutBeingReadWhole() throws Exception {
        String id = freshId();
        StringBuilder torn = new StringBuilder("{\"type\":\"llm_response\",\"xid\":\"a\",\"status\":200,\"lines\":[");
        String streamLine = "\"data: " + "y".repeat(1015) + "\",";
        for (int i = 0; i < 2048; i++) {
            torn.append(streamLine);
        }
        torn.append("\"data: cut mid-wr");
        long skipped = utf8(torn.toString()).length;
        write(id, utf8("{\"type\":\"llm_request\",\"xid\":\"a\",\"ts\":1}\n" + torn));

        List<Map<String, Object>> old = LlmWireIndexOracle.index(sidecar(id));
        assertNotNull(old);
        assertEquals(1, old.size());
        assertNull(old.get(0).get("status"), "the old index dropped the torn response and left the exchange open");
        assertEquals(json(old), json(served(id)));

        com.sun.management.ThreadMXBean threads =
                (com.sun.management.ThreadMXBean) ManagementFactory.getThreadMXBean();
        long least = Long.MAX_VALUE;
        for (int round = 0; round < 3; round++) {
            long before = threads.getCurrentThreadAllocatedBytes();
            served(id);
            least = Math.min(least, threads.getCurrentThreadAllocatedBytes() - before);
        }
        System.out.println("card 434: indexing a torn tail line of " + skipped + " bytes allocated "
                + least + " bytes in the smallest of three calls");
        assertTrue(least < skipped / 4,
                "indexing a torn tail line of " + skipped + " bytes allocated " + least
                        + " bytes in the smallest of three calls; the bound is " + (skipped / 4));
    }

    // ---- 2. the same answer as the oracle ----------------------------------

    static Stream<Arguments> fixtures() {
        List<Arguments> all = new ArrayList<>();
        all.add(Arguments.of("a paired request and response", (Fixture) id ->
                recorded(id, LlmWireRecorder.DEFAULT_CEILING_BYTES, recorder -> {
                    LlmWireTap.Exchange exchange = recorder.bound("main", 1)
                            .begin(request("{\"model\":\"claude-sonnet-5\"}", 1000L));
                    exchange.line("data: {\"type\":\"message_start\"}");
                    exchange.line("data: {\"type\":\"message_stop\"}");
                    exchange.end(new WireOutcome(200, "bytes", null, false, null, 1600L));
                })));
        all.add(Arguments.of("an open request", (Fixture) id ->
                recorded(id, LlmWireRecorder.DEFAULT_CEILING_BYTES, recorder ->
                        recorder.bound("main", 2).begin(new WireRequest("ollama", "glm-5.3:cloud",
                                "http", "POST", "http://localhost:11434/api/chat", null,
                                "bytes", "{\"turn\":2}", 2000L)))));
        all.add(Arguments.of("interleaved subagents", (Fixture) id ->
                recorded(id, LlmWireRecorder.DEFAULT_CEILING_BYTES, recorder -> {
                    LlmWireTap.Exchange main = recorder.bound("main", 3).begin(request("main asks", 3000L));
                    LlmWireTap.Exchange sub = recorder.bound("sub-1", 1, "compaction")
                            .begin(request("sub asks", 3100L));
                    LlmWireTap.Exchange image = recorder.bound("sub-2", null, "image")
                            .begin(request("draw it", 3150L));
                    sub.line("data: sub 1");
                    main.line("data: main 1");
                    sub.end(new WireOutcome(200, "sdk-json", "{\"single\":\"payload\"}", false, null, 3300L));
                    main.line("data: main 2");
                    image.end(new WireOutcome(null, "bytes", null, true, "cancelled", 3350L));
                    main.end(new WireOutcome(529, "bytes", null, false, "overloaded", 3400L));
                })));
        all.add(Arguments.of("a torn tail line", (Fixture) id -> {
            recorded(id, LlmWireRecorder.DEFAULT_CEILING_BYTES, recorder -> {
                LlmWireTap.Exchange done = recorder.bound("main", 1).begin(request("first", 1000L));
                done.line("data: one");
                done.end(new WireOutcome(200, "bytes", null, false, null, 1200L));
                recorder.bound("main", 2).begin(request("second", 2000L));
            });
            String open = openXid(id);
            append(id, utf8("{\"type\":\"llm_response\",\"xid\":\"" + open
                    + "\",\"agentId\":\"main\",\"status\":200,\"lines\":[\"data: cut mid-wr"));
        }));
        all.add(Arguments.of("the truncation marker", (Fixture) id ->
                recorded(id, 700, recorder -> {
                    LlmWireTap.Exchange fits = recorder.bound("main", 1).begin(request("small", 1000L));
                    fits.line("data: ok");
                    fits.end(new WireOutcome(200, "bytes", null, false, null, 1100L));
                    LlmWireTap.Exchange over = recorder.bound("main", 2)
                            .begin(request("b".repeat(4000), 2000L));
                    over.line("data: dropped 1");
                    over.line("data: dropped 2");
                    over.line("data: dropped 3");
                    over.end(new WireOutcome(200, "bytes", null, false, null, 2500L));
                    LlmWireTap.Exchange after = recorder.bound("main", 3).begin(request("c", 3000L));
                    after.end(new WireOutcome(200, "bytes", "{\"late\":true}", false, null, 3100L));
                })));
        all.add(Arguments.of("duplicate keys and loosely typed values", (Fixture) id -> write(id, utf8(String.join("\n",
                "{\"type\":\"llm_response\",\"type\":\"llm_request\",\"xid\":\"a\",\"turn\":\"7\","
                        + "\"bodyBytes\":\"12\",\"ts\":1.9,\"model\":5,\"agentId\":null,\"url\":{\"k\":1}}",
                "{\"type\":\"llm_response\",\"xid\":\"a\",\"status\":\"201\",\"lines\":[1,2],\"lines\":null,"
                        + "\"lineCount\":4,\"aborted\":\"true\",\"durationMs\":3.5,\"ts\":2}",
                "{\"type\":\"llm_request\",\"xid\":\"b\",\"headers\":{\"status\":1,\"type\":\"llm_response\"},"
                        + "\"body\":{\"nested\":[1,{\"x\":\"y\"}]},\"ts\":3,\"turn\":12345678901}",
                "{\"type\":\"llm_response\",\"xid\":\"b\",\"lines\":[],\"lines\":[\"a\",{\"b\":[1]},null],"
                        + "\"status\":null,\"bodyBytes\":-5,\"ts\":4}",
                "{\"xid\":\"c\",\"type\":\"llm_request\",\"ts\":5,\"transport\":true} trailing words",
                "{\"type\":\"llm_request\",\"xid\":\"d\",\"lines\":[1,2,3],\"fidelity\":[\"x\"],"
                        + "\"status\":404,\"kind\":\"\\u00e9t\\u00e9 \\ud83d\\ude00\",\"ts\":6}",
                "{\"type\":\"llm_response\",\"xid\":\"d\",\"lines\":{\"0\":\"not an array\"},\"lineCount\":\"9\","
                        + "\"aborted\":1,\"durationMs\":null,\"ts\":\"7\"}",
                "")))));
        all.add(Arguments.of("numbers the old tree converted", (Fixture) id -> write(id, utf8(String.join("\n",
                "{\"type\":\"llm_request\",\"xid\":\"n\",\"headers\":{\"a\":1e99999,\"b\":-0,\"c\":"
                        + "9".repeat(1000) + ",\"d\":1." + "5".repeat(990) + "E-400},\"ts\":1}",
                "{\"type\":\"llm_request\",\"xid\":\"m\",\"body\":[" + "1".repeat(1001) + "],\"ts\":2}",
                "{\"type\":\"llm_response\",\"xid\":\"n\",\"status\":2147483648,\"durationMs\":1e3,"
                        + "\"ts\":9223372036854775808,\"bodyBytes\":1.5e300,\"lineCount\":-0.0}",
                "")))));
        all.add(Arguments.of("lines the old reader ignores", (Fixture) id -> write(id, concat(
                utf8("\n   \n\t\n[1,2]\n\"llm_request\"\n42\nnull\n{\n}\n{}\n"),
                utf8("{\"type\":\"llm_response\",\"xid\":\"late\",\"status\":200,\"ts\":1}\n"),
                utf8("{\"type\":\"llm_request\",\"xid\":\"late\",\"ts\":2}\n"),
                utf8("{\"type\":\"llm_response\",\"xid\":\"nobody\",\"status\":200,\"ts\":3}\n"),
                utf8("{\"type\":\"llm_wire_truncated\",\"reachedBytes\":1,\"ceilingBytes\":2,\"ts\":4}\n"),
                utf8("{\"type\":\"something_else\",\"xid\":\"late\",\"status\":500,\"ts\":5}\n"),
                utf8("﻿{\"type\":\"llm_request\",\"xid\":\"bom\",\"ts\":6}\n"),
                utf8("\u0000{\"type\":\"llm_request\",\"xid\":\"nul-first\",\"ts\":7}\n"),
                utf8(" \u0000{\"type\":\"llm_request\",\"xid\":\"nul-second\",\"ts\":8}\n"),
                utf8("{\u0000\"type\":\"llm_request\",\"xid\":\"nul-inside\",\"ts\":9}\n"),
                "{\"type\":\"llm_request\",\"xid\":\"utf-16be\",\"ts\":15}".getBytes(StandardCharsets.UTF_16BE),
                utf8("\n"),
                "{\"type\":\"llm_request\",\"xid\":\"utf-16le\",\"ts\":16}".getBytes(StandardCharsets.UTF_16LE),
                utf8("\n"),
                utf8("  {\"type\":\"llm_request\",\"xid\":\"indented\",\"ts\":10}  \n"),
                utf8("{\"type\":\"llm_request\",\"xid\":\"ctrl\",\"body\":\"tab\there\",\"ts\":11}\n"),
                utf8("{\"type\":\"llm_request\",\"xid\":\"escape\",\"body\":\"bad \\q escape\",\"ts\":12}\n"),
                utf8("{\"type\":\"llm_request\",\"xid\":\"deep\",\"body\":" + "[".repeat(1001)
                        + "]".repeat(1001) + ",\"ts\":13}\n"),
                utf8("{\"type\":\"llm_request\",\"xid\":\"last\",\"ts\":14}")))));
        all.add(Arguments.of("carriage return and line feed endings", (Fixture) id -> write(id, utf8(
                "{\"type\":\"llm_request\",\"xid\":\"a\",\"ts\":1}\r\n"
                        + "{\"type\":\"llm_request\",\"xid\":\"b\",\"ts\":2}\r\n"
                        + "{\"type\":\"llm_response\",\"xid\":\"a\",\"status\":200,\"lines\":[\"x\"],\"ts\":3}\r\n"
                        + "\r\n"
                        + "{\"type\":\"llm_response\",\"xid\":\"b\",\"status\":204,\"ts\":4}\r"))));
        all.add(Arguments.of("field names long in UTF-8 bytes but not in characters", (Fixture) id -> {
            String name = "é".repeat(30_000);
            write(id, utf8(String.join("\n",
                    "{\"type\":\"llm_request\",\"xid\":\"h\",\"headers\":{\"" + name + "\":\"v\"},\"ts\":1}",
                    "{\"type\":\"llm_response\",\"xid\":\"h\",\"status\":200,\"ts\":2}",
                    "{\"type\":\"llm_request\",\"xid\":\"t\",\"ts\":3}",
                    "{\"type\":\"llm_response\",\"xid\":\"t\",\"" + name + "\":0,\"status\":201,\"ts\":4}",
                    "{\"type\":\"llm_request\",\"xid\":\"l\",\"ts\":5}",
                    "{\"type\":\"llm_response\",\"xid\":\"l\",\"status\":202,\"lines\":[{\"" + name + "\":1},\"x\"],"
                            + "\"ts\":6}",
                    "{\"type\":\"llm_request\",\"xid\":\"u\",\"url\":{\"" + name + "\":1},\"ts\":7}",
                    "")));
        }));
        return all.stream();
    }

    /** Writes one fixture sidecar for the given session id. */
    @FunctionalInterface
    interface Fixture {
        void writeInto(String id) throws IOException;
    }

    private static String openXid(String id) throws IOException {
        String open = null;
        for (String line : Files.readAllLines(sidecar(id))) {
            var node = JSON.readTree(line);
            if ("llm_request".equals(node.path("type").asText())) {
                open = node.path("xid").asText();
            }
        }
        return open;
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("fixtures")
    void theIndexAnswersExactlyWhatTheOldIndexAnswered(String name, Fixture fixture) throws Exception {
        String id = freshId();
        fixture.writeInto(id);

        List<Map<String, Object>> old = LlmWireIndexOracle.index(sidecar(id));
        assertNotNull(old, "the old index answered this fixture");
        assertTrue(!old.isEmpty(), "the fixture holds at least one exchange the old index lists");
        assertEquals(json(old), json(served(id)), name);
    }

    /**
     * Random sidecars from a fixed seed: recorder-like lines with the kept
     * fields, bodies, headers and {@code lines} in random order and shape,
     * duplicate keys, torn and non-object lines, and LF, CR LF or CR as the
     * terminator. Every byte is valid UTF-8, so the old index answers each one.
     */
    @ParameterizedTest(name = "seed {0}")
    @org.junit.jupiter.params.provider.ValueSource(longs = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12})
    void randomSidecarsGetTheOldAnswer(long seed) throws Exception {
        java.util.Random random = new java.util.Random(seed);
        StringBuilder file = new StringBuilder();
        for (int i = 0; i < 400; i++) {
            String line = randomLine(random);
            int roll = random.nextInt(100);
            if (roll < 6) {
                line = line.substring(0, random.nextInt(line.length()));
            } else if (roll < 9) {
                line = randomValue(random, 3);
            } else if (roll < 11) {
                line = random.nextBoolean() ? "" : " \t ";
            }
            file.append(line).append(List.of("\n", "\n", "\n", "\r\n", "\r").get(random.nextInt(5)));
        }
        String id = freshId();
        write(id, utf8(file.toString()));

        List<Map<String, Object>> old = LlmWireIndexOracle.index(sidecar(id));
        assertNotNull(old);
        assertTrue(old.stream().anyMatch(e -> e.get("status") != null),
                "the seed pairs at least one response, so the comparison covers both halves");
        assertEquals(json(old), json(served(id)));
    }

    private static final List<String> NAMES = List.of("type", "xid", "agentId", "turn", "kind", "provider",
            "model", "transport", "url", "status", "bodyBytes", "fidelity", "ts", "aborted", "durationMs",
            "lineCount", "lines", "body", "headers", "method", "omitted", "error", "other");

    private static String randomLine(java.util.Random random) {
        List<String> fields = new ArrayList<>();
        String type = List.of("llm_request", "llm_response", "llm_response", "llm_wire_truncated")
                .get(random.nextInt(4));
        fields.add("\"type\":" + (random.nextInt(10) == 0 ? randomValue(random, 1) : quoted(type)));
        if (type.equals("llm_response") && random.nextInt(10) != 0) {
            fields.add("\"status\":" + (200 + random.nextInt(300)));
        }
        fields.add("\"xid\":" + (random.nextInt(20) == 0 ? randomValue(random, 1) : quoted("x" + random.nextInt(30))));
        int more = random.nextInt(12);
        for (int i = 0; i < more; i++) {
            String name = NAMES.get(random.nextInt(NAMES.size()));
            String value = switch (name) {
                case "lines" -> random.nextInt(4) == 0 ? randomValue(random, 1) : randomArray(random, 2);
                case "status", "turn", "bodyBytes", "ts", "durationMs", "lineCount" ->
                        random.nextInt(4) == 0 ? randomValue(random, 1) : Integer.toString(random.nextInt(100000));
                default -> randomValue(random, 0);
            };
            fields.add(quoted(name) + ":" + value);
        }
        java.util.Collections.shuffle(fields, random);
        return " ".repeat(random.nextInt(2)) + "{" + String.join(",", fields) + "}";
    }

    private static String randomValue(java.util.Random random, int depth) {
        return switch (random.nextInt(depth > 2 ? 6 : 8)) {
            case 0 -> "null";
            case 1 -> random.nextBoolean() ? "true" : "false";
            case 2 -> Integer.toString(random.nextInt(2001) - 1000);
            case 3 -> Long.toString(random.nextLong());
            case 4 -> List.of("1.5", "-0.0", "3e2", "1E-7", "12345678901234567890", "2147483648",
                    "9.999e307").get(random.nextInt(7));
            case 5 -> quoted(randomText(random));
            case 6 -> randomArray(random, depth + 1);
            default -> {
                int n = random.nextInt(4);
                List<String> members = new ArrayList<>();
                for (int i = 0; i < n; i++) {
                    members.add(quoted(NAMES.get(random.nextInt(NAMES.size()))) + ":" + randomValue(random, depth + 1));
                }
                yield "{" + String.join(",", members) + "}";
            }
        };
    }

    private static String randomArray(java.util.Random random, int depth) {
        int n = random.nextInt(5);
        List<String> items = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            items.add(randomValue(random, depth + 1));
        }
        return "[" + String.join(",", items) + "]";
    }

    private static String randomText(java.util.Random random) {
        List<String> pieces = List.of("a", "data: ", "\u00e9", "\ud83d\ude00", "\\n", "\\\"", "\\u00e9",
                "\\ud83d\\ude00", " ", "llm_request", "{\\\"x\\\":1}", "0");
        StringBuilder text = new StringBuilder();
        int n = random.nextInt(8);
        for (int i = 0; i < n; i++) {
            text.append(pieces.get(random.nextInt(pieces.size())));
        }
        return text.toString();
    }

    private static String quoted(String text) {
        return "\"" + text + "\"";
    }

    /**
     * The reader asks for the file in 64 KiB chunks, and a regular file answers
     * such a read in full. Here the chunk border falls on each of the last
     * bytes of a line, its two four-byte characters, a
     * two-byte one, the closing quote and brace, and on each form of
     * terminator, and the answer stays the old one.
     */
    @Test
    void aChunkBorderInsideACharacterOrATerminatorChangesNothing() throws Exception {
        int chunk = 1 << 16;
        String tail = "\ud83d\ude00\ud83d\ude00\u00e9\"}";
        String head = "{\"type\":\"llm_request\",\"xid\":\"f\",\"ts\":1,\"body\":\"";
        int fixed = utf8(head).length + utf8(tail).length;
        for (String terminator : List.of("\n", "\r\n", "\r")) {
            for (int shift = -14; shift <= 2; shift++) {
                String line = head + "p".repeat(chunk - 1 + shift - fixed) + tail;
                String id = freshId();
                write(id, utf8(line + terminator
                        + "{\"type\":\"llm_response\",\"xid\":\"f\",\"status\":200,\"lines\":[\"\u00e9\"],\"ts\":2}"
                        + terminator + "{\"type\":\"llm_request\",\"xid\":\"g\",\"ts\":3}" + terminator));
                assertEquals(chunk - 1 + shift, utf8(line).length, "the terminator starts at the planned byte");

                List<Map<String, Object>> old = LlmWireIndexOracle.index(sidecar(id));
                assertNotNull(old);
                assertEquals(java.util.Arrays.asList(200, null), old.stream().map(e -> e.get("status")).toList());
                assertEquals(json(old), json(served(id)), "terminator " + terminator.replace("\r", "CR")
                        .replace("\n", "LF") + ", shift " + shift);
            }
        }
    }

    // ---- 3. the two edge cases the new reader decides ----------------------

    @Test
    void aByteSequenceTheUtf8DecoderRefusesSkipsOnlyItsLine() throws Exception {
        byte[] good1 = utf8("{\"type\":\"llm_request\",\"xid\":\"good-1\",\"body\":\"fine\",\"ts\":1}\n");
        byte[] good2 = utf8("{\"type\":\"llm_request\",\"xid\":\"good-2\",\"ts\":2}\n");
        byte[] good3 = utf8("{\"type\":\"llm_response\",\"xid\":\"good-1\",\"status\":200,\"ts\":3}\n");
        // In a body the parser meets the bytes too; after the object only the
        // UTF-8 check does, because the parser stops at the closing brace.
        List<byte[]> refused = List.of(
                inBody("ff", "a byte that never starts a sequence"),
                inBody("c080", "an overlong encoding of NUL"),
                inBody("eda080", "a surrogate encoded as three bytes"),
                inBody("f4908080", "a code point above U+10FFFF"),
                inBody("e282", "a three byte sequence cut short"),
                afterObject("ff", "a byte that never starts a sequence"),
                afterObject("80", "a continuation byte without a lead"),
                afterObject("c1bf", "an overlong two byte lead"),
                afterObject("e08080", "an overlong three byte form"),
                afterObject("eda080", "a surrogate encoded as three bytes"),
                afterObject("f0808080", "an overlong four byte form"),
                afterObject("f4908080", "a code point above U+10FFFF"),
                afterObject("f5808080", "a lead past F4"),
                afterObject("c24180", "a lead whose continuation comes after an ASCII byte"),
                afterObject("c2" + "41".repeat(8) + "80", "a lead whose continuation comes eight ASCII bytes later"),
                afterObject("c2", "a lead at the end of the line"));

        for (byte[] bad : refused) {
            String what = new String(bad, StandardCharsets.ISO_8859_1);
            String alone = freshId();
            write(alone, concat(good1, bad, good2));
            assertNull(LlmWireIndexOracle.index(sidecar(alone)),
                    "the old index answered 404 for the whole sidecar: " + what);
            List<Map<String, Object>> index = served(alone);
            assertEquals(List.of("good-1", "good-2"), index.stream().map(e -> e.get("xid")).toList(),
                    "only the refused line is skipped: " + what);
        }

        String id = freshId();
        String without = freshId();
        List<byte[]> mixed = new ArrayList<>(List.of(good1));
        mixed.addAll(refused);
        mixed.add(good2);
        mixed.add(good3);
        write(id, concat(mixed.toArray(new byte[0][])));
        write(without, concat(good1, good2, good3));
        List<Map<String, Object>> expected = LlmWireIndexOracle.index(sidecar(without));
        assertNotNull(expected);
        assertEquals(200, expected.get(0).get("status"), "the response after the refused lines still pairs");
        assertEquals(json(expected), json(served(id)));
    }

    /** A request line whose body carries the given bytes (hex), then a line feed. */
    private static byte[] inBody(String hex, String what) {
        return concat(utf8("{\"type\":\"llm_request\",\"xid\":\"bad body: " + what + "\",\"body\":\"<"),
                HexFormat.of().parseHex(hex), utf8(">\",\"ts\":9}\n"));
    }

    /** A whole request line followed by the given bytes (hex) and a line feed. */
    private static byte[] afterObject(String hex, String what) {
        return concat(utf8("{\"type\":\"llm_request\",\"xid\":\"bad tail: " + what + "\",\"ts\":9} "),
                HexFormat.of().parseHex(hex), utf8("\n"));
    }

    /**
     * The reader passes eight bytes at once while they are plain ASCII,
     * counting from where it starts on a line. Here a two-byte character, a
     * CR, an LF and a refused sequence each stand at every offset modulo 8
     * from the line's first byte, and every one is still seen.
     */
    @Test
    void everyByteOfAnEightByteWordIsSeen() throws Exception {
        ByteArrayOutputStream good = new ByteArrayOutputStream();
        ByteArrayOutputStream bad = new ByteArrayOutputStream();
        java.util.Set<Integer> twoByte = new java.util.TreeSet<>();
        java.util.Set<Integer> carriageReturn = new java.util.TreeSet<>();
        java.util.Set<Integer> lineFeed = new java.util.TreeSet<>();
        java.util.Set<Integer> refusedAt = new java.util.TreeSet<>();
        int n = 0;
        for (String terminator : List.of("\r", "\n")) {
            for (int k = 0; k < 8; k++) {
                String xid = String.format("a%02d", n++);
                String pad = "p".repeat(k);
                String head = "{\"type\":\"llm_request\",\"xid\":\"" + xid + "\",\"body\":\"" + pad;
                byte[] request = utf8(head + "\u00e9\",\"ts\":1}" + terminator);
                twoByte.add(utf8(head).length % 8);
                (terminator.equals("\r") ? carriageReturn : lineFeed).add((request.length - 1) % 8);
                byte[] response = utf8("{\"type\":\"llm_response\",\"xid\":\"" + xid + "\",\"status\":201}\n");
                String before = "{\"type\":\"llm_request\",\"xid\":\"bad\",\"ts\":1} " + pad;
                byte[] refused = concat(utf8(before), HexFormat.of().parseHex("c080"), utf8("\n"));
                refusedAt.add(utf8(before).length % 8);
                good.writeBytes(request);
                good.writeBytes(response);
                bad.writeBytes(request);
                bad.writeBytes(refused);
                bad.writeBytes(response);
            }
        }
        java.util.Set<Integer> everyOffset = new java.util.TreeSet<>(List.of(0, 1, 2, 3, 4, 5, 6, 7));
        assertEquals(everyOffset, twoByte);
        assertEquals(everyOffset, carriageReturn);
        assertEquals(everyOffset, lineFeed);
        assertEquals(everyOffset, refusedAt);
        String clean = freshId();
        String mixed = freshId();
        write(clean, good.toByteArray());
        write(mixed, bad.toByteArray());

        List<Map<String, Object>> old = LlmWireIndexOracle.index(sidecar(clean));
        assertNotNull(old);
        assertEquals(16, old.size());
        assertTrue(old.stream().allMatch(e -> Integer.valueOf(201).equals(e.get("status"))),
                "every response paired in the old index");
        assertEquals(json(old), json(served(clean)));
        assertNull(LlmWireIndexOracle.index(sidecar(mixed)), "the old index refused the file with the bad lines");
        assertEquals(json(old), json(served(mixed)), "the new one skips exactly the sixteen refused lines");
    }

    @Test
    void aLoneCarriageReturnEndsALineAsTheOldReaderDid() throws Exception {
        String id = freshId();
        write(id, utf8("{\"type\":\"llm_request\",\"xid\":\"a\",\"ts\":1}\r"
                + "{\"type\":\"llm_response\",\"xid\":\"a\",\"status\":200,\"lines\":[\"x\",\"y\"],\"ts\":2}\r"
                + "\r"
                + "{\"type\":\"llm_request\",\"xid\":\"b\",\"ts\":3}\n"
                + "{\"type\":\"llm_response\",\"xid\":\"b\",\"status\":201,\"ts\":4}\r\n"
                + "{\"type\":\"llm_request\",\"xid\":\"c\",\"ts\":5}\n\r"
                + "{\"type\":\"llm_response\",\"xid\":\"c\",\"status\":202,\"ts\":6}"));

        List<Map<String, Object>> old = LlmWireIndexOracle.index(sidecar(id));
        assertNotNull(old);
        assertEquals(List.of(200, 201, 202), old.stream().map(e -> e.get("status")).toList(),
                "the old reader split on every carriage return and paired all three");
        assertEquals(json(old), json(served(id)));
    }

    @Test
    void aStringPastJacksonsLengthLimitDropsItsLineAsTheOldIndexDid() throws Exception {
        int limit = JSON.getFactory().streamReadConstraints().getMaxStringLength();
        String id = freshId();
        try {
            // The first line is past the limit, so the long lines that stay
            // start deep in the file, well past the first 64 KiB chunk.
            recorded(id, Long.MAX_VALUE, recorder -> {
                recorder.bound("main", 2).begin(request("b".repeat(limit + 1), 2000L));
                recorder.bound("main", 1).begin(request("a".repeat(limit), 1000L));
                LlmWireTap.Exchange third = recorder.bound("main", 3).begin(request("c", 3000L));
                third.end(new WireOutcome(200, "bytes", "d".repeat(limit + 1), false, null, 3500L));
                LlmWireTap.Exchange fourth = recorder.bound("main", 4).begin(request("e", 4000L));
                fourth.end(new WireOutcome(201, "bytes", "f".repeat(limit), false, null, 4500L));
            });
            List<Map<String, Object>> old = LlmWireIndexOracle.index(sidecar(id));
            assertNotNull(old);
            assertEquals(List.of(1, 3, 4), old.stream().map(e -> e.get("turn")).toList(),
                    "the old index dropped the request whose body is one past the limit");
            assertEquals((long) limit, old.get(0).get("requestBytes"), "and kept the one at the limit");
            assertNull(old.get(1).get("status"), "it left the exchange whose response is past the limit open");
            assertEquals(201, old.get(2).get("status"), "and closed the one whose response is at the limit");
            assertEquals(json(old), json(served(id)));
        } finally {
            Files.deleteIfExists(sidecar(id));
        }
    }

    /**
     * Jackson limits a field name's length. On a String it counts characters,
     * on bytes it counts UTF-8 bytes, so a name of two-byte characters can
     * pass the one and fail the other. The old index kept such a line; here
     * the names sit at both ends of that range and one past it.
     */
    @Test
    void aFieldNameLongInBytesButNotInCharactersKeepsItsLineAsTheOldIndexDid() throws Exception {
        int limit = JSON.getFactory().streamReadConstraints().getMaxNameLength();
        String shortest = "é".repeat(limit / 2 + 1);
        String longest = "é".repeat(limit);
        assertTrue(utf8(shortest).length > limit, "the shortest name is past the limit in bytes");
        String id = freshId();
        write(id, utf8(String.join("\n",
                "{\"type\":\"llm_request\",\"xid\":\"a\",\"headers\":{\"" + shortest + "\":\"v\"},\"ts\":1}",
                "{\"type\":\"llm_request\",\"xid\":\"b\",\"headers\":{\"" + longest + "\":\"v\"},\"ts\":2}",
                "{\"type\":\"llm_request\",\"xid\":\"c\",\"headers\":{\"" + longest + "é\":\"v\"},\"ts\":3}",
                "{\"type\":\"llm_request\",\"xid\":\"d\",\"headers\":{\"" + "a".repeat(limit + 1) + "\":\"v\"},\"ts\":4}",
                "{\"type\":\"llm_response\",\"xid\":\"a\",\"" + shortest + "\":0,\"status\":200,\"ts\":5}",
                "")));

        List<Map<String, Object>> old = LlmWireIndexOracle.index(sidecar(id));
        assertNotNull(old);
        assertEquals(List.of("a", "b"), old.stream().map(e -> e.get("xid")).toList(),
                "the old index kept the names up to the limit in characters and dropped the two past it");
        assertEquals(200, old.get(0).get("status"), "and closed the exchange whose response holds such a name");
        assertEquals(json(old), json(served(id)));
    }
}
