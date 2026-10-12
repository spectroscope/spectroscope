package dev.spectroscope.core.peer;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.messaging.AgentRow;
import dev.spectroscope.core.messaging.ListAgentsTool;
import dev.spectroscope.core.messaging.SendMessageTool;
import dev.spectroscope.core.messaging.SessionSeat;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 503, criteria 1 to 3 against the registry of card 502: the main
 * agent's seat lists the other sessions with their folder, status line and
 * face, never its own session, and a send_message by name reaches the other
 * process's session.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class SessionSeatTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path home;

    private final List<AutoCloseable> closing = new ArrayList<>();
    private final List<Process> processes = new ArrayList<>();

    @AfterEach
    void close() throws Exception {
        for (AutoCloseable c : closing) {
            c.close();
        }
        processes.forEach(Process::destroyForcibly);
    }

    private static void await(BooleanSupplier condition, String what) throws InterruptedException {
        long until = System.currentTimeMillis() + 10_000;
        while (!condition.getAsBoolean()) {
            if (System.currentTimeMillis() > until) {
                throw new AssertionError("timed out waiting for " + what);
            }
            Thread.sleep(20);
        }
    }

    private record Setup(PeerNode a, PeerNodeTest.FakeSession sa, PeerNodeTest.FakeSession sa2, PeerNode b,
                         PeerNodeTest.FakeSession sb, PeerNodeTest.FakeHost hostB) {
    }

    private Setup setup() throws IOException {
        LiveRegistry registry = new LiveRegistry(home.resolve(".spectro/live"));
        MessagesSidecar sidecar = new MessagesSidecar(home.resolve(".spectro/messages"));
        Process sleeper = new ProcessBuilder("sleep", "60").start();
        processes.add(sleeper);
        PeerNodeTest.FakeHost hostA = new PeerNodeTest.FakeHost("server");
        PeerNodeTest.FakeHost hostB = new PeerNodeTest.FakeHost("repl");
        PeerNodeTest.FakeSession sa = new PeerNodeTest.FakeSession("20261011-090000-aaaaaaaa",
                home.resolve("ForgeDemo").toString(), "auto");
        PeerNodeTest.FakeSession sa2 = new PeerNodeTest.FakeSession("20261011-090100-a2a2a2a2",
                home.resolve("Other").toString(), "auto");
        PeerNodeTest.FakeSession sb = new PeerNodeTest.FakeSession("20261011-090500-bbbbbbbb",
                home.resolve("ForgeDemo").toString(), "auto");
        hostA.sessions.add(sa);
        hostA.sessions.add(sa2);
        hostB.sessions.add(sb);
        PeerNode a = new PeerNode(registry, ProcessIdentity.current(), "0.15.1", hostA, sidecar,
                Duration.ofMinutes(10));
        PeerNode b = new PeerNode(registry, ProcessIdentity.of(sleeper.pid()).orElseThrow(), "0.15.1", hostB,
                sidecar, Duration.ofMinutes(10));
        a.start();
        b.start();
        closing.add(a);
        closing.add(b);
        a.roster();
        b.roster();
        a.flush();
        b.flush();
        return new Setup(a, sa, sa2, b, sb, hostB);
    }

    private static SessionSeat seat(PeerNode node, PeerNodeTest.FakeSession session, boolean on) {
        return new SessionSeat(() -> node, session::id, () -> null, () -> on, "main");
    }

    @Test
    void theSeatListsTheOtherSessionsWithFolderStatusLineAndFaceButNotItsOwn() throws Exception {
        Setup s = setup();
        s.sb().running = true;
        s.b().flush();
        List<AgentRow> rows = seat(s.a(), s.sa(), true).sessions();
        List<String> ids = rows.stream().map(AgentRow::id).toList();
        assertFalse(ids.contains(s.sa().id), "its own session is not a row");
        assertTrue(ids.contains(s.sa2().id), "another session of the same process is");
        AgentRow b = rows.stream().filter(r -> r.id().equals(s.sb().id)).findFirst().orElseThrow();
        assertEquals("repl", b.face());
        assertEquals("busy", b.status());
        assertEquals("running read_file", b.statusLine());
        assertEquals(s.sb().cwd, b.folder());
        assertEquals(s.b().nameOf(s.sb().id), b.name());
        assertEquals(PeerNames.ref("session", s.sb().id), b.ref());
        assertTrue(b.accepting());
        String listing = new ListAgentsTool(seat(s.a(), s.sa(), true)).execute(JSON.createObjectNode(),
                new Tool.ToolContext(Path.of("."), new CancelSignal()));
        assertTrue(listing.startsWith("This session is " + s.a().nameOf(s.sa().id) + " ["), listing);
        assertTrue(listing.contains("Peer sessions (2):"), listing);
        assertTrue(listing.contains(" · repl · busy · " + s.sb().cwd + " · running read_file · started "), listing);
    }

    @Test
    void aSessionOfAProcessThatTakesNoMessagesIsListedAsNotAccepting() throws Exception {
        Setup s = setup();
        s.hostB().accepting = false;
        s.b().flush();
        AgentRow b = seat(s.a(), s.sa(), true).sessions().stream().filter(r -> r.id().equals(s.sb().id))
                .findFirst().orElseThrow();
        assertFalse(b.accepting());
    }

    @Test
    void sendMessageByNameReachesTheOtherProcess() throws Exception {
        Setup s = setup();
        s.sb().running = true;
        s.sb().inbox.open();
        s.b().flush();
        String name = s.b().nameOf(s.sb().id);
        String out = new SendMessageTool(seat(s.a(), s.sa(), true)).execute(
                JSON.createObjectNode().put("to", name).put("message", "which files did you touch?"),
                new Tool.ToolContext(Path.of("."), new CancelSignal()));
        assertTrue(out.startsWith("Sent \"which files did you touch?\" to " + name + " ["), out);
        await(() -> s.sb().inbox.size() == 1, "the message in the other inbox");
    }

    /**
     * The scenario's return leg: the second agent copies the from attribute
     * of the message it got and answers through send_message, across two
     * processes, and the answer reaches the sending session.
     */
    @Test
    void theSecondAgentAnswersThroughTheFromAddressItWasSent() throws Exception {
        Setup s = setup();
        s.sb().running = true;
        s.sb().inbox.open();
        s.sa().running = true;
        s.sa().inbox.open();
        s.a().flush();
        s.b().flush();
        new SendMessageTool(seat(s.a(), s.sa(), true)).execute(
                JSON.createObjectNode().put("to", s.b().nameOf(s.sb().id)).put("message", "which files did you touch?"),
                new Tool.ToolContext(Path.of("."), new CancelSignal()));
        await(() -> s.sb().events.stream().anyMatch(e -> received(e)), "the question at B");
        String from = s.sb().events.stream().filter(e -> received(e)).findFirst().orElseThrow()
                .envelope().from();
        assertTrue(from.startsWith("uds:") && from.endsWith("/" + s.sa().id), from);
        String out = new SendMessageTool(seat(s.b(), s.sb(), true)).execute(
                JSON.createObjectNode().put("to", from).put("message", "Parser.java and its tests."),
                new Tool.ToolContext(Path.of("."), new CancelSignal()));
        assertTrue(out.startsWith("Sent \"Parser.java and its tests.\" to " + s.a().nameOf(s.sa().id) + " ["),
                out);
        await(() -> s.sa().events.stream().anyMatch(e -> received(e)), "the answer at A");
        PeerEvent answer = s.sa().events.stream().filter(e -> received(e)).findFirst()
                .orElseThrow();
        assertEquals("Parser.java and its tests.", answer.envelope().text());
        assertEquals(s.b().address() + "/" + s.sb().id, answer.envelope().from());
        assertTrue(s.sa2().events.stream().noneMatch(e -> received(e)),
                "the other session of A's process did not get it");
    }

    @Test
    void aLongNameIsCutInTheRowAndInTheSenderNameOfAMessage() throws Exception {
        Setup s = setup();
        s.sb().title = "n".repeat(5_000);
        s.sb().running = true;
        s.sb().inbox.open();
        s.sa().running = true;
        s.sa().inbox.open();
        s.a().flush();
        s.b().flush();
        assertEquals(5_000, s.b().nameOf(s.sb().id).length(), "the registry holds the whole name");
        AgentRow b = seat(s.a(), s.sa(), true).sessions().stream().filter(r -> r.id().equals(s.sb().id))
                .findFirst().orElseThrow();
        assertEquals("n".repeat(PeerLimits.LISTING_LINE_CAP), b.name());
        LiveRecord recordOfA = s.b().roster().stream().filter(r -> r.pid() == s.a().pid()).findFirst()
                .orElseThrow();
        assertTrue(s.b().sendTo(s.sb().id, recordOfA, s.sa().id, "A", "hello", null).sent());
        await(() -> s.sa().events.stream().anyMatch(e -> received(e)), "the message at A");
        PeerEvent got = s.sa().events.stream().filter(e -> received(e)).findFirst().orElseThrow();
        assertEquals("n".repeat(PeerLimits.LISTING_LINE_CAP), got.envelope().fromName());
    }

    private static boolean received(PeerEvent e) {
        return "message".equals(e.kind()) && "received".equals(e.direction());
    }
}
