package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.peer.LiveRecord;
import dev.spectroscope.core.peer.LiveRegistry;
import dev.spectroscope.core.peer.MessagesSidecar;
import dev.spectroscope.core.peer.PeerEvent;
import dev.spectroscope.core.peer.PeerHost;
import dev.spectroscope.core.peer.PeerNode;
import dev.spectroscope.core.peer.PeerSession;
import dev.spectroscope.core.peer.PeerStatus;
import dev.spectroscope.core.peer.ProcessIdentity;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import dev.spectroscope.orchestrator.ProcessBusHub;
import picocli.CommandLine;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 502 criteria 1 and 6 on the CLI: every face writes its record at start
 * and deletes it at exit, and an unattended face refuses what other agents
 * send it.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class PeerFaceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void anUnattendedFaceIsListedAndRefusesAndItsRecordLeavesWithIt() throws Exception {
        Path live = LiveRegistry.defaultDir();
        PeerSession run = PeerFace.unattended("20261011-130000-0a0a0a0a", Path.of("/tmp/ForgeDemo"), "auto");
        PeerNode node = PeerFace.register("headless", false, () -> List.of(run));
        assertNotNull(node);
        Path file = live.resolve(ProcessHandle.current().pid() + ".json");
        JsonNode record = JSON.readTree(file.toFile());
        assertEquals("headless", record.get("face").asText());
        assertFalse(record.get("accepting").asBoolean());
        assertEquals("/tmp/ForgeDemo", record.get("sessions").get(0).get("cwd").asText());

        Process sleeper = new ProcessBuilder("sleep", "60").start();
        List<PeerEvent> events = new CopyOnWriteArrayList<>();
        PeerSession sender = senderSession(events);
        PeerNode other = new PeerNode(new LiveRegistry(live), ProcessIdentity.of(sleeper.pid()).orElseThrow(),
                "test", host(sender), new MessagesSidecar(live.resolveSibling("messages")), Duration.ofMinutes(1));
        try {
            other.start();
            LiveRecord target = other.roster().stream().filter(r -> r.pid() == ProcessHandle.current().pid())
                    .findFirst().orElseThrow();
            assertTrue(other.sendTo(sender.id(), target, run.id(), "run", "hello", null).sent());
            long until = System.currentTimeMillis() + 10_000;
            while (events.stream().noneMatch(e -> e.status() == PeerStatus.REFUSED)
                    && System.currentTimeMillis() < until) {
                Thread.sleep(20);
            }
            assertTrue(events.stream().anyMatch(e -> e.status() == PeerStatus.REFUSED), events.toString());
        } finally {
            other.close();
            sleeper.destroyForcibly();
        }
        PeerFace.close(node);
        assertFalse(Files.exists(file), "deleted at exit");
    }

    /** What a face's record said while its command ran, read by the seam in {@link PeerFace}. */
    private record Seen(String face, boolean fileExisted, Path file) {
    }

    private static List<Seen> watchRegistrations() {
        List<Seen> seen = new CopyOnWriteArrayList<>();
        PeerFace.started = node -> {
            LiveRecord record = node.record();
            Path file = LiveRegistry.defaultDir().resolve(record.pid() + ".json");
            seen.add(new Seen(record.face(), Files.exists(file), file));
        };
        return seen;
    }

    @Test
    void spectroRunRegistersAsHeadlessAndItsRecordLeavesWithTheRun(@TempDir Path workspace) {
        List<Seen> seen = watchRegistrations();
        try {
            new CommandLine(new SpectroCli()).execute("--provider", "ollama", "--model", "qwen2.5:7b",
                    "--base-url", "http://localhost:9", "--workspace", workspace.toString(),
                    "run", "-p", "hi", "--max-turns", "1");
        } finally {
            PeerFace.started = node -> { };
        }
        assertEquals(1, seen.size(), seen.toString());
        assertEquals("headless", seen.getFirst().face());
        assertTrue(seen.getFirst().fileExisted(), "the record existed while the run ran");
        assertFalse(Files.exists(seen.getFirst().file()), "deleted when the run ended");
    }

    @Test
    void spectroNodeRegistersAsNodeAndItsRecordLeavesWithTheNode(@TempDir Path workspace) throws Exception {
        List<Seen> seen = watchRegistrations();
        try (ProcessBusHub hub = new ProcessBusHub(0)) {
            new CommandLine(new SpectroCli()).execute("--provider", "ollama", "--model", "qwen2.5:7b",
                    "--base-url", "http://localhost:9", "--workspace", workspace.toString(),
                    "node", "-p", "scan", "--hub", "127.0.0.1:" + hub.port(), "--context", "fleet-peer",
                    "--max-turns", "1");
        } finally {
            PeerFace.started = node -> { };
        }
        assertEquals(1, seen.size(), seen.toString());
        assertEquals("node", seen.getFirst().face());
        assertTrue(seen.getFirst().fileExisted(), "the record existed while the node ran");
        assertFalse(Files.exists(seen.getFirst().file()), "deleted when the node ended");
    }

    @Test
    void theReplAndTheCronSchedulerNameTheirFaceWordAtTheRegistrationCallSite() throws Exception {
        // The REPL waits on a console and cron runs until Ctrl+C, so these two
        // are a listing of call sites, not a run. Cron registers the scheduler
        // process, not each job it fires.
        Path cli = Path.of("src/main/java/dev/spectroscope/cli");
        assertTrue(Files.readString(cli.resolve("SpectroCli.java")).contains("PeerFace.register(\"repl\", true"));
        assertTrue(Files.readString(cli.resolve("CronCommand.java")).contains("PeerFace.register(\"cron\", false"));
        for (String file : List.of("SpectroCli.java", "CronCommand.java")) {
            assertTrue(Files.readString(cli.resolve(file)).contains("PeerFace.close("), file + " closes its node");
        }
    }

    private static PeerSession senderSession(List<PeerEvent> events) {
        return new PeerSession() {
            final dev.spectroscope.core.peer.PeerInbox inbox = new dev.spectroscope.core.peer.PeerInbox();

            @Override public String id() {
                return "20261011-130500-0b0b0b0b";
            }

            @Override public String cwd() {
                return "/tmp";
            }

            @Override public String title() {
                return null;
            }

            @Override public String mode() {
                return "auto";
            }

            @Override public boolean running() {
                return true;
            }

            @Override public String statusLine() {
                return "working";
            }

            @Override public Integer turn() {
                return null;
            }

            @Override public long since() {
                return 0;
            }

            @Override public dev.spectroscope.core.peer.PeerInbox inbox() {
                return inbox;
            }

            @Override public boolean startRun(String prompt) {
                return false;
            }

            @Override public boolean isChild(String name) {
                return false;
            }

            @Override public void onPeerEvent(PeerEvent event) {
                events.add(event);
            }
        };
    }

    private static PeerHost host(PeerSession session) {
        return new PeerHost() {
            @Override public String face() {
                return "repl";
            }

            @Override public boolean attended() {
                return true;
            }

            @Override public boolean accepting() {
                return true;
            }

            @Override public List<PeerSession> sessions() {
                return List.of(session);
            }
        };
    }
}
