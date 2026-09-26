package dev.spectroscope.core.session;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.trace.JsonlSink;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 406: two writers on one session file, and what a reader does with a
 * line it cannot parse.
 *
 * <p>{@code Files.writeString} hands the bytes to the file in chunks of 8,192,
 * one {@code write} call each. A line longer than that is several writes, and
 * a second writer's line can land between two of them. That is the tear
 * measured on 2026-09-24: an {@code llm_exchange} line starting 8,192 or
 * 16,384 bytes into a {@code context_info} line.</p>
 */
class SessionFileTearTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Stricter than the store's own reader: a line carrying a second object after the first fails too. */
    private static final ObjectMapper STRICT =
            new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    private static String freshId() {
        return "tear-" + UUID.randomUUID().toString().substring(0, 8);
    }

    /** A context_info line of about 20,000 bytes: it straddles 8,192 and 16,384. */
    private static RunEvent.ContextInfo longContextInfo(int turn, int messages, long ts) {
        String text = "x".repeat(20_000);
        return new RunEvent.ContextInfo("main", turn, messages, 5_000, 100_000,
                List.of(new RunEvent.ContextPart("conversation", text.length(), text.length() / 4, text)),
                ts, "fallback", null);
    }

    private static RunEvent.LlmExchange exchange(int n) {
        return new RunEvent.LlmExchange("xid-" + n, "main", 1, "chat", "ollama", "m", "http",
                "http://localhost:11434/api/chat", 200, 23_886, 353, 2, false, "bytes", 24, n);
    }

    @Test
    void twoWritersOnOneSessionFileNeverTearALine() throws Exception {
        SessionStore store = new SessionStore(freshId());
        appendFromTwoThreadsAndFindTornLines(store, store);
    }

    @Test
    void twoStoresOpenedOnOneIdInThisProcessNeverTearALine() throws Exception {
        String id = freshId();
        // Two instances on one id: the lock is keyed by the file, not held by
        // the instance, so both writers must still take the same lock.
        appendFromTwoThreadsAndFindTornLines(new SessionStore(id), new SessionStore(id));
    }

    /**
     * Appends long context_info lines through a JsonlSink on one thread and
     * llm_exchange lines directly on a second, then asserts that every line of
     * the file parses on its own.
     *
     * @param runStore      the store writer 1 (the run's drainer) appends through
     * @param providerStore the store writer 2 (the provider thread) appends to
     */
    private static void appendFromTwoThreadsAndFindTornLines(SessionStore runStore,
                                                             SessionStore providerStore)
            throws Exception {
        assertEquals(runStore.file(), providerStore.file(), "both writers append to one file");
        // Writer 1 is the run's own drainer: every event through the sink.
        JsonlSink sink = new JsonlSink(runStore);
        // Writer 2 is the provider thread closing an exchange: a monitor of its
        // own (the connection's), none shared with writer 1.
        Object connectionMonitor = new Object();

        int contextLines = 400;
        CountDownLatch start = new CountDownLatch(1);
        AtomicBoolean runDone = new AtomicBoolean(false);
        AtomicInteger exchanges = new AtomicInteger();
        AtomicReference<Throwable> failure = new AtomicReference<>();

        Thread run = new Thread(() -> {
            try {
                start.await();
                for (int i = 0; i < contextLines; i++) {
                    sink.onEvent(longContextInfo(i + 1, i, i));
                }
            } catch (Throwable t) {
                failure.compareAndSet(null, t);
            } finally {
                runDone.set(true);
            }
        }, "tear-test-run");
        Thread provider = new Thread(() -> {
            try {
                start.await();
                while (!runDone.get() && exchanges.get() < 50_000) {
                    int n = exchanges.incrementAndGet();
                    synchronized (connectionMonitor) {
                        providerStore.append(exchange(n));
                    }
                }
            } catch (Throwable t) {
                failure.compareAndSet(null, t);
            }
        }, "tear-test-provider");
        run.start();
        provider.start();
        start.countDown();
        run.join();
        provider.join();
        assertNull(failure.get(), () -> "a writer failed: " + failure.get());

        byte[] bytes = Files.readAllBytes(runStore.file());
        List<Integer> torn = new ArrayList<>();
        Map<String, Integer> byType = new LinkedHashMap<>();
        int number = 0;
        for (String line : new String(bytes, StandardCharsets.UTF_8).split("\n")) {
            number++;
            if (line.isBlank()) {
                continue;
            }
            try {
                JsonNode node = STRICT.readTree(line);
                byType.merge(node.get("type").asText(), 1, Integer::sum);
            } catch (IOException tornLine) {
                torn.add(number);
            }
        }
        assertEquals(List.of(), torn, "lines that do not parse, by line number");
        assertEquals(contextLines, byType.getOrDefault("context_info", 0));
        assertEquals(exchanges.get(), byType.getOrDefault("llm_exchange", 0));
        assertTrue(exchanges.get() > 0, "the second writer started appending before the first finished");
    }

    /** Captures the store's WARN records while the body runs. */
    private static <T> T capturing(List<ILoggingEvent> into, Supplier<T> body) {
        Logger logger = (Logger) LoggerFactory.getLogger(SessionStore.class);
        Level before = logger.getLevel();
        ListAppender<ILoggingEvent> records = new ListAppender<>();
        records.start();
        logger.setLevel(Level.WARN);
        logger.addAppender(records);
        try {
            return body.get();
        } finally {
            logger.detachAppender(records);
            logger.setLevel(before);
            into.addAll(records.list);
        }
    }

    private static List<String> warningsAbout(List<ILoggingEvent> records, String id) {
        return records.stream()
                .filter(record -> record.getLevel() == Level.WARN)
                .map(ILoggingEvent::getFormattedMessage)
                .filter(message -> message.contains(id))
                .toList();
    }

    private static List<RunEvent> read(String id) {
        try {
            return SessionStore.readSessionEvents(id);
        } catch (IOException unreadable) {
            throw new AssertionError(unreadable);
        }
    }

    @Test
    void aTornLineAmongAThousandIsSkippedAndReportedBySessionIdAndLineNumber() throws IOException {
        SessionStore store = new SessionStore(freshId());
        for (int i = 1; i <= 1000; i++) {
            store.append(new RunEvent.TextDelta("main", "event-" + i, i));
        }
        List<String> lines = new ArrayList<>(Files.readAllLines(store.file(), StandardCharsets.UTF_8));
        String whole = lines.get(499);
        lines.set(499, whole.substring(0, whole.length() / 2)); // line 500 cut in half
        Files.writeString(store.file(), String.join("\n", lines) + "\n", StandardCharsets.UTF_8);

        List<ILoggingEvent> records = new ArrayList<>();
        List<RunEvent> events = capturing(records, () -> read(store.id()));

        List<String> expected = new ArrayList<>();
        for (int i = 1; i <= 1000; i++) {
            if (i != 500) {
                expected.add("event-" + i);
            }
        }
        assertEquals(999, events.size());
        List<String> texts = events.stream()
                .map(event -> assertInstanceOfDelta(event).text())
                .toList();
        assertEquals(expected, texts, "the 999 good events, in file order");
        assertFalse(events.contains(null), "no null stands in for the torn line");
        assertFalse(texts.contains("event-500"), "no half built event from the torn line");

        List<String> warnings = warningsAbout(records, store.id());
        assertEquals(1, warnings.size(), () -> "one report for the one torn line: " + warnings);
        assertTrue(warnings.getFirst().contains(" line 500 "),
                () -> "the report names the line number: " + warnings.getFirst());
    }

    private static RunEvent.TextDelta assertInstanceOfDelta(RunEvent event) {
        assertNotNull(event, "a null in the result");
        assertTrue(event instanceof RunEvent.TextDelta, () -> "not a text_delta: " + event);
        return (RunEvent.TextDelta) event;
    }

    /**
     * Builds a session file the way an older build left it after the measured
     * tear: turn 3's context_info cut 8,192 bytes in, a whole llm_exchange line
     * in the gap, and the rest of the context_info on the next line.
     */
    private static List<RunEvent> writeFileTornLikeTheMeasuredOnes(String id) throws IOException {
        return writeFileTornLikeTheMeasuredOnes(id, longContextInfo(3, 5, 9), "turn three answer");
    }

    /**
     * The same file, with the torn record and turn 3's answer given.
     *
     * @param id              the session id to write
     * @param tornRecord      turn 3's context_info, the line the tear cuts at byte 8,192
     * @param turnThreeAnswer the text of the good text_delta after the tear
     * @return the events of every good line, in file order
     */
    private static List<RunEvent> writeFileTornLikeTheMeasuredOnes(String id,
                                                                   RunEvent.ContextInfo tornRecord,
                                                                   String turnThreeAnswer)
            throws IOException {
        RunEvent intruder = exchange(10);
        List<RunEvent> before = List.of(
                new RunEvent.RunStart("r1", "main", null, "first question", "ollama", null, 1L),
                new RunEvent.TurnStart("main", 1, 2L),
                longContextInfo(1, 1, 3),
                new RunEvent.TextDelta("main", "turn one answer", 4L),
                new RunEvent.TurnStart("main", 2, 5L),
                longContextInfo(2, 3, 6),
                new RunEvent.TextDelta("main", "turn two answer", 7L),
                new RunEvent.TurnStart("main", 3, 8L));
        List<RunEvent> after = List.of(
                new RunEvent.TextDelta("main", turnThreeAnswer, 11L),
                new RunEvent.Usage("main", 100, 20, 12L),
                new RunEvent.RunEnd("r1", "end_turn", 13L));

        ByteArrayOutputStream file = new ByteArrayOutputStream();
        for (RunEvent event : before) {
            file.write((JSON.writeValueAsString(event) + "\n").getBytes(StandardCharsets.UTF_8));
        }
        byte[] torn = (JSON.writeValueAsString(tornRecord) + "\n").getBytes(StandardCharsets.UTF_8);
        file.write(Arrays.copyOfRange(torn, 0, 8192));
        file.write((JSON.writeValueAsString(intruder) + "\n").getBytes(StandardCharsets.UTF_8));
        file.write(Arrays.copyOfRange(torn, 8192, torn.length));
        for (RunEvent event : after) {
            file.write((JSON.writeValueAsString(event) + "\n").getBytes(StandardCharsets.UTF_8));
        }
        Files.write(SessionStore.sessionFile(id), file.toByteArray());

        List<RunEvent> good = new ArrayList<>(before);
        good.addAll(after);
        return good;
    }

    @Test
    void theWorkspaceReaderNamesATornRunStartLineAndTakesTheNextRun() throws IOException {
        SessionStore store = new SessionStore(freshId());
        String torn = JSON.writeValueAsString(new RunEvent.RunStart("r1", "main", null, "first",
                "ollama", null, null, null, "/work/first", 1L));
        Files.writeString(store.file(), torn.substring(0, torn.length() - 20) + "\n",
                StandardCharsets.UTF_8);
        store.append(new RunEvent.RunStart("r2", "main", null, "second",
                "ollama", null, null, null, "/work/second", 2L));

        List<ILoggingEvent> records = new ArrayList<>();
        String workspace = capturing(records, () -> SessionStore.recordedWorkspace(store.id()));

        assertEquals("/work/second", workspace);
        List<String> warnings = warningsAbout(records, store.id());
        assertEquals(1, warnings.size(), () -> String.valueOf(warnings));
        assertTrue(warnings.getFirst().contains(" line 1 "), warnings::getFirst);
    }

    @Test
    void theWindowReaderNamesATornOverrideLineAndKeepsTheOneBefore() throws IOException {
        SessionStore store = new SessionStore(freshId());
        store.append(new RunEvent.WindowOverride(64_000, 51_200, "window_override", 64_000, 1L));
        String torn = JSON.writeValueAsString(
                new RunEvent.WindowOverride(128_000, 102_400, "window_override", 128_000, 2L));
        Files.writeString(store.file(), torn.substring(0, torn.length() - 10) + "\n",
                StandardCharsets.UTF_8, java.nio.file.StandardOpenOption.APPEND);

        List<ILoggingEvent> records = new ArrayList<>();
        Integer window = capturing(records, () -> SessionStore.recordedWindowOverride(store.id()));

        assertEquals(64_000, window);
        List<String> warnings = warningsAbout(records, store.id());
        assertEquals(1, warnings.size(), () -> String.valueOf(warnings));
        assertTrue(warnings.getFirst().contains(" line 2 "), warnings::getFirst);
    }

    @Test
    void aSessionTornBeforeTheLockReadsEveryGoodLineAndNamesBothTornLines() throws IOException {
        String id = freshId();
        new SessionStore(id); // creates the sessions directory
        List<RunEvent> good = writeFileTornLikeTheMeasuredOnes(id);

        List<ILoggingEvent> records = new ArrayList<>();
        // The archive view reads the events; a resume rebuilds the history and
        // counts the events; the sidebar folds the row.
        List<RunEvent> events = capturing(records, () -> read(id));
        List<ProviderMessage> history = capturing(records, () -> {
            try {
                return SessionStore.loadSession(id);
            } catch (IOException unreadable) {
                throw new AssertionError(unreadable);
            }
        });
        int counted = capturing(records, () -> SessionStore.eventCount(id));
        SessionStore.SessionInfo row = capturing(records, () -> SessionStore.listSessions().stream()
                .filter(info -> info.id().equals(id))
                .findFirst()
                .orElseThrow());

        assertEquals(good, events, "every good line, before and after the tear, in file order");
        assertEquals(good.size(), counted);
        assertEquals(3, row.turnCount(), "turn 3's turn_start is a good line");
        assertTrue(history.stream()
                        .flatMap(message -> message.content().stream())
                        .anyMatch(content -> content instanceof TextContent text
                                && text.text().equals("turn three answer")),
                "the resumed history carries turn 3's answer");

        List<String> warnings = warningsAbout(records, id).stream().distinct().toList();
        assertEquals(2, warnings.size(), () -> "the two physical lines of the tear: " + warnings);
        assertTrue(warnings.get(0).contains(" line 9 "), () -> warnings.get(0));
        assertTrue(warnings.get(1).contains(" line 10 "), () -> warnings.get(1));
    }

    /**
     * Turn 3's context_info with German text, padded so that one 'ä' (0xC3 0xA4)
     * sits at bytes 8,191 and 8,192 of its line: a tear at byte 8,192 cuts the
     * character in two.
     */
    private static RunEvent.ContextInfo contextInfoWithAnUmlautAcrossByte8192(int turn, int messages,
                                                                            long ts) throws IOException {
        // One repeat of the phrase is 19 bytes, so some padding below 19 lands a lead byte on 8,191.
        for (int pad = 0; pad < 19; pad++) {
            String text = "x".repeat(pad) + "Grüße aus Köln, ".repeat(1_300);
            RunEvent.ContextInfo info = new RunEvent.ContextInfo("main", turn, messages, 5_000, 100_000,
                    List.of(new RunEvent.ContextPart("conversation", text.length(), text.length() / 4, text)),
                    ts, "fallback", null);
            byte[] line = JSON.writeValueAsBytes(info);
            if (line[8191] == (byte) 0xC3 && (line[8192] & 0xC0) == 0x80) {
                return info;
            }
        }
        throw new AssertionError("no padding puts a two byte character across byte 8,192");
    }

    /** True when the bytes are not valid UTF-8 as a whole. */
    private static boolean notUtf8(byte[] bytes) {
        try {
            StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes));
            return false;
        } catch (CharacterCodingException malformed) {
            return true;
        }
    }

    /** The bytes of one event's line, without the newline. */
    private static byte[] lineBytes(RunEvent event) throws IOException {
        return JSON.writeValueAsBytes(event);
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] part : parts) {
            out.writeBytes(part);
        }
        return out.toByteArray();
    }

    private static final byte[] NEWLINE = {'\n'};

    @Test
    void aTearInsideATwoByteCharacterIsSkippedAndEveryGoodLineIsStillRead() throws IOException {
        String id = freshId();
        new SessionStore(id); // creates the sessions directory
        List<RunEvent> good = writeFileTornLikeTheMeasuredOnes(id,
                contextInfoWithAnUmlautAcrossByte8192(3, 5, 9), "Antwort für Runde drei");
        assertTrue(notUtf8(Files.readAllBytes(SessionStore.sessionFile(id))),
                "the fixture holds a character cut in two, so the file as a whole is not UTF-8");

        List<ILoggingEvent> records = new ArrayList<>();
        List<RunEvent> events = capturing(records, () -> read(id));
        List<ProviderMessage> history = capturing(records, () -> {
            try {
                return SessionStore.loadSession(id);
            } catch (IOException unreadable) {
                throw new AssertionError(unreadable);
            }
        });
        int counted = capturing(records, () -> SessionStore.eventCount(id));
        List<SessionStore.SessionInfo> rows = capturing(records, () -> SessionStore.listSessions().stream()
                .filter(info -> info.id().equals(id))
                .toList());

        assertEquals(good, events, "every good line, before and after the tear, in file order");
        assertEquals(good.size(), counted);
        assertEquals(1, rows.size(), "the session keeps its row in the sidebar");
        assertEquals(3, rows.getFirst().turnCount(), "turn 3's turn_start is a good line");
        assertTrue(history.stream()
                        .flatMap(message -> message.content().stream())
                        .anyMatch(content -> content instanceof TextContent text
                                && text.text().equals("Antwort für Runde drei")),
                "the resumed history carries turn 3's answer, umlaut intact");

        List<String> warnings = warningsAbout(records, id).stream().distinct().toList();
        assertEquals(2, warnings.size(), () -> "the two physical lines of the tear: " + warnings);
        assertTrue(warnings.get(0).contains(" line 9 "), () -> warnings.get(0));
        assertTrue(warnings.get(1).contains(" line 10 "), () -> warnings.get(1));
    }

    @Test
    void theWorkspaceReaderSkipsARunStartLineThatIsNotUtf8AndTakesTheNextRun() throws IOException {
        SessionStore store = new SessionStore(freshId());
        byte[] first = lineBytes(new RunEvent.RunStart("r1", "main", null, "first",
                "ollama", null, null, null, "/work/für-später", 1L));
        int umlaut = indexOf(first, (byte) 0xC3);
        byte[] cutInsideTheUmlaut = Arrays.copyOfRange(first, 0, umlaut + 1);
        Files.write(store.file(), concat(cutInsideTheUmlaut, NEWLINE));
        store.append(new RunEvent.RunStart("r2", "main", null, "second",
                "ollama", null, null, null, "/work/second", 2L));
        assertTrue(notUtf8(Files.readAllBytes(store.file())), "line 1 ends inside a character");

        List<ILoggingEvent> records = new ArrayList<>();
        String workspace = capturing(records, () -> SessionStore.recordedWorkspace(store.id()));

        assertEquals("/work/second", workspace);
        List<String> warnings = warningsAbout(records, store.id());
        assertEquals(1, warnings.size(), () -> String.valueOf(warnings));
        assertTrue(warnings.getFirst().contains(" line 1 "), warnings::getFirst);
    }

    @Test
    void theWindowReaderSkipsATornLineThatIsNotUtf8AndKeepsTheOneBefore() throws IOException {
        SessionStore store = new SessionStore(freshId());
        store.append(new RunEvent.WindowOverride(64_000, 51_200, "window_override", 64_000, 1L));
        // The measured tear, with a window_override as the line that lands in
        // the gap, so the torn line names the type this reader looks for.
        byte[] torn = concat(lineBytes(contextInfoWithAnUmlautAcrossByte8192(1, 1, 2)), NEWLINE);
        byte[] intruder = concat(lineBytes(
                new RunEvent.WindowOverride(128_000, 102_400, "window_override", 128_000, 3L)), NEWLINE);
        Files.write(store.file(), concat(Arrays.copyOfRange(torn, 0, 8192), intruder,
                Arrays.copyOfRange(torn, 8192, torn.length)), java.nio.file.StandardOpenOption.APPEND);
        assertTrue(notUtf8(Files.readAllBytes(store.file())), "line 2 ends inside a character");

        List<ILoggingEvent> records = new ArrayList<>();
        Integer window = capturing(records, () -> SessionStore.recordedWindowOverride(store.id()));

        assertEquals(64_000, window);
        List<String> warnings = warningsAbout(records, store.id());
        assertEquals(1, warnings.size(), () -> String.valueOf(warnings));
        assertTrue(warnings.getFirst().contains(" line 2 "), warnings::getFirst);
    }

    @Test
    void aLineThatIsNotUtf8IsSkippedAndReportedEvenWhereItsJsonIsWhole() throws IOException {
        SessionStore store = new SessionStore(freshId());
        store.append(new RunEvent.TextDelta("main", "before", 1L));
        byte[] line = lineBytes(new RunEvent.TextDelta("main", "Grüße", 2L));
        int lead = indexOf(line, (byte) 0xC3);
        // Drop the lead byte of the 'ü': the JSON around it is whole, the bytes are not UTF-8.
        byte[] loneContinuation = concat(Arrays.copyOfRange(line, 0, lead),
                Arrays.copyOfRange(line, lead + 1, line.length));
        Files.write(store.file(), concat(loneContinuation, NEWLINE), java.nio.file.StandardOpenOption.APPEND);
        store.append(new RunEvent.TextDelta("main", "after", 3L));
        assertTrue(notUtf8(Files.readAllBytes(store.file())), "line 2 holds a byte that starts no character");

        List<ILoggingEvent> records = new ArrayList<>();
        List<RunEvent> events = capturing(records, () -> read(store.id()));

        assertEquals(List.of("before", "after"),
                events.stream().map(event -> assertInstanceOfDelta(event).text()).toList(),
                "no event with a replacement character stands in for line 2");
        List<String> warnings = warningsAbout(records, store.id());
        assertEquals(1, warnings.size(), () -> String.valueOf(warnings));
        assertTrue(warnings.getFirst().contains(" line 2 "), warnings::getFirst);
    }

    private static int indexOf(byte[] bytes, byte wanted) {
        for (int index = 0; index < bytes.length; index++) {
            if (bytes[index] == wanted) {
                return index;
            }
        }
        throw new AssertionError("byte not found");
    }
}
