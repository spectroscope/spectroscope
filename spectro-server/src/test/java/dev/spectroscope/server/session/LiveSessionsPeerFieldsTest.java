package dev.spectroscope.server.session;

import dev.spectroscope.core.peer.LiveRecord;
import dev.spectroscope.core.peer.PeerEvent;
import dev.spectroscope.core.peer.PeerInbox;
import dev.spectroscope.core.peer.PeerSession;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 502 criterion 13: {@code live_sessions} and {@code GET /api/sessions/live}
 * grow folder, name, status line, face and pid, additively; the machine scope
 * adds the sessions of other processes from the registry.
 */
class LiveSessionsPeerFieldsTest {

    static PeerSession port(String id, String cwd, String statusLine) {
        return new PeerSession() {
            @Override public String id() {
                return id;
            }

            @Override public String cwd() {
                return cwd;
            }

            @Override public String title() {
                return null;
            }

            @Override public String mode() {
                return "ask";
            }

            @Override public boolean running() {
                return false;
            }

            @Override public String statusLine() {
                return statusLine;
            }

            @Override public Integer turn() {
                return null;
            }

            @Override public long since() {
                return 0;
            }

            @Override public PeerInbox inbox() {
                return new PeerInbox();
            }

            @Override public boolean startRun(String prompt) {
                return false;
            }

            @Override public boolean isChild(String name) {
                return false;
            }

            @Override public void onPeerEvent(PeerEvent event) {
            }
        };
    }

    @Test
    void aRowCarriesFolderNameStatusLineFaceAndPid() {
        LiveSessions live = new LiveSessions();
        live.claim("ws-1", "s-1");
        live.port("ws-1", port("s-1", "/Users/x/ForgeDemo", "running read_file"));
        live.bridge(new LiveSessions.PeerBridge() {
            @Override public String nameOf(String sessionId) {
                return "ForgeDemo-7f";
            }

            @Override public List<LiveRecord> others() {
                return List.of();
            }

            @Override public void decide(String sessionId, String msgId, boolean deliver) {
            }
        });

        LiveSessions.LiveSession row = live.snapshot().getFirst();

        assertThat(row.id()).isEqualTo("s-1");
        assertThat(row.folder()).isEqualTo("/Users/x/ForgeDemo");
        assertThat(row.name()).isEqualTo("ForgeDemo-7f");
        assertThat(row.statusLine()).isEqualTo("running read_file");
        assertThat(row.face()).isEqualTo("server");
        assertThat(row.pid()).isEqualTo(ProcessHandle.current().pid());
    }

    @Test
    void theOldThreeFieldRowIsStillTheRowOfASessionWithoutAPort() {
        LiveSessions live = new LiveSessions();
        live.claim("ws-1", "s-1");
        LiveSessions.LiveSession row = live.snapshot().getFirst();
        assertThat(row).isEqualTo(new LiveSessions.LiveSession("s-1", false, row.since()));
    }

    @Test
    void aTouchPublishesTheNewStatusLine() {
        LiveSessions live = new LiveSessions();
        live.claim("ws-1", "s-1");
        List<List<LiveSessions.LiveSession>> seen = new ArrayList<>();
        live.addListener(seen::add);
        live.touch("ws-1", "s-1");
        assertThat(seen).hasSize(2);
        live.touch("ws-other", "s-1");
        assertThat(seen).as("only the holder moves the row").hasSize(2);
    }

    @Test
    void theMachineScopeAddsTheSessionsOfOtherProcesses() {
        LiveSessions live = new LiveSessions();
        live.claim("ws-1", "s-1");
        LiveRecord foreign = new LiveRecord(4711, "2026-10-11T08:00:00.000Z", 1L, "repl", "0.15.1", 1, List.of(),
                "/tmp/4711.sock", true, List.of(new LiveRecord.Session("s-9", "ForgeDemo-a1", "derived",
                "/Users/x/ForgeDemo", "busy", "running grep", 4, "auto", 5L, 6L)));
        live.bridge(new LiveSessions.PeerBridge() {
            @Override public String nameOf(String sessionId) {
                return sessionId;
            }

            @Override public List<LiveRecord> others() {
                return List.of(foreign);
            }

            @Override public void decide(String sessionId, String msgId, boolean deliver) {
            }
        });
        LiveSessionsController controller = new LiveSessionsController(live);

        assertThat(controller.live(null)).extracting(LiveSessions.LiveSession::id).containsExactly("s-1");
        List<LiveSessions.LiveSession> machine = controller.live("machine");
        assertThat(machine).extracting(LiveSessions.LiveSession::id).containsExactly("s-1", "s-9");
        LiveSessions.LiveSession other = machine.get(1);
        assertThat(other.face()).isEqualTo("repl");
        assertThat(other.pid()).isEqualTo(4711L);
        assertThat(other.folder()).isEqualTo("/Users/x/ForgeDemo");
        assertThat(other.statusLine()).isEqualTo("running grep");
        assertThat(other.running()).isTrue();
    }

    @Test
    void theRosterGoesToEveryRosterListener() {
        LiveSessions live = new LiveSessions();
        List<List<LiveSessions.LiveSession>> seen = new ArrayList<>();
        live.addRosterListener(seen::add);
        assertThat(seen).as("an empty roster is not pushed on connect").isEmpty();
        live.publishRoster(List.of(new LiveSessions.LiveSession("s-9", true, 5L, "/f", "n", "busy", "repl", 4711L)));
        assertThat(seen).hasSize(1);
        assertThat(seen.get(0)).extracting(LiveSessions.LiveSession::face).containsExactly("repl");
        List<List<LiveSessions.LiveSession>> late = new ArrayList<>();
        live.addRosterListener(late::add);
        assertThat(late).as("a later viewer gets the last roster at once").hasSize(1);
    }
}
