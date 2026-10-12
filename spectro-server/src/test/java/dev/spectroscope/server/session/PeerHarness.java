package dev.spectroscope.server.session;

import dev.spectroscope.core.peer.LiveRecord;
import dev.spectroscope.core.peer.LiveRegistry;
import dev.spectroscope.core.peer.MessagesSidecar;
import dev.spectroscope.core.peer.PeerEvent;
import dev.spectroscope.core.peer.PeerHost;
import dev.spectroscope.core.peer.PeerInbox;
import dev.spectroscope.core.peer.PeerNode;
import dev.spectroscope.core.peer.PeerSession;
import dev.spectroscope.core.peer.PeerStatus;
import dev.spectroscope.core.peer.ProcessIdentity;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Card 502: a server's {@link PeerService} on a temp registry, plus a second
 * process that sends to it. The second process borrows the identity of a real
 * {@code sleep}, so both the hello check and the auth check see two live
 * processes.
 */
final class PeerHarness implements AutoCloseable {

    final LiveSessions live = new LiveSessions();
    final PeerService service;
    final PeerNode sender;
    final Sender senderSession;
    private final Process sleeper;

    /** The sending session, driven by hand. */
    static final class Sender implements PeerSession {
        final String mode;
        final List<PeerEvent> events = new CopyOnWriteArrayList<>();
        final PeerInbox inbox = new PeerInbox();

        Sender(String mode) {
            this.mode = mode;
        }

        @Override public String id() {
            return "20261011-120000-5e5e5e5e";
        }

        @Override public String cwd() {
            return "/tmp/ForgeDemo";
        }

        @Override public String title() {
            return null;
        }

        @Override public String mode() {
            return mode;
        }

        @Override public boolean running() {
            return true;
        }

        @Override public String statusLine() {
            return "working";
        }

        @Override public Integer turn() {
            return 1;
        }

        @Override public long since() {
            return 1L;
        }

        @Override public PeerInbox inbox() {
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

        List<PeerStatus> statuses() {
            return events.stream().filter(e -> "status".equals(e.kind())).map(PeerEvent::status).toList();
        }
    }

    PeerHarness(Path home, String senderMode) throws IOException {
        this(home, senderMode, MessagingSwitch.USER);
    }

    /** Card 503: a harness whose server reads its messaging switch from {@code messaging}. */
    PeerHarness(Path home, String senderMode, MessagingSwitch messaging) throws IOException {
        LiveRegistry registry = new LiveRegistry(home.resolve(".spectro/live"));
        MessagesSidecar sidecar = new MessagesSidecar(home.resolve(".spectro/messages"));
        service = PeerService.started(live, registry, ProcessIdentity.current(), sidecar, Duration.ofMinutes(10),
                messaging);
        sleeper = new ProcessBuilder("sleep", "120").start();
        senderSession = new Sender(senderMode);
        PeerHost host = new PeerHost() {
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
                return List.of(senderSession);
            }
        };
        sender = new PeerNode(registry, ProcessIdentity.of(sleeper.pid()).orElseThrow(), "test", host, sidecar,
                Duration.ofMinutes(10));
        sender.start();
    }

    /** @return the server's record as the sender lists it now */
    LiveRecord serverRecord() {
        return sender.roster().stream().filter(r -> r.pid() == ProcessHandle.current().pid())
                .findFirst().orElseThrow(() -> new AssertionError("the server's record is not in the registry"));
    }

    /** Sends one message to a session of this JVM's server. @return the msg_id */
    String send(String toSession, String text) {
        LiveRecord server = sender.roster().stream().filter(r -> r.pid() == ProcessHandle.current().pid())
                .findFirst().orElseThrow(() -> new AssertionError("the server's record is not in the registry"));
        PeerNode.SendResult result = sender.sendTo(senderSession.id(), server, toSession, "receiver", text, null);
        if (!result.sent()) {
            throw new AssertionError("not sent: " + result.text());
        }
        return result.msgId();
    }

    void awaitStatus(PeerStatus status) throws InterruptedException {
        long until = System.currentTimeMillis() + 30_000;
        while (!senderSession.statuses().contains(status)) {
            if (System.currentTimeMillis() > until) {
                throw new AssertionError("no " + status + " status; statuses " + senderSession.statuses());
            }
            Thread.sleep(25);
        }
    }

    @Override
    public void close() {
        sender.close();
        service.stop();
        sleeper.destroyForcibly();
    }
}
