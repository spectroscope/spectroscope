package dev.spectroscope.server.session;

import dev.spectroscope.server.session.LiveSessions.LiveSession;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The registry behind card 212: WHICH sessions are live on this server right
 * now, and who is allowed to hold one.
 *
 * <p>Two facts are pinned here, and both were previously unrepresentable. The
 * first is plural liveness — before this class the only session anybody could
 * call live was the one the asking page held a socket to, so a second run was
 * invisible from the first tab. The second is exclusivity: two sockets on ONE
 * session id would mean two {@code SessionStore} instances appending to one
 * JSONL file and two agents replaying one history, so the second one is
 * REFUSED rather than made to share.
 */
class LiveSessionsTest {

    /** Collects every snapshot pushed at a listener, in order. */
    private static final class Spy implements LiveSessions.Listener {
        final List<List<LiveSession>> pushes = new ArrayList<>();

        @Override
        public void onLiveSessions(List<LiveSession> live) {
            pushes.add(live);
        }

        List<LiveSession> latest() {
            return pushes.get(pushes.size() - 1);
        }
    }

    /** The ids of a snapshot, in the order the registry reports them. */
    private static List<String> ids(List<LiveSession> live) {
        return live.stream().map(LiveSession::id).toList();
    }

    @Test
    void severalSessionsAreLiveAtTheSameTime() {
        LiveSessions registry = new LiveSessions();

        assertThat(registry.claim("socket-a", "20260813-100000-aaaaaaaa")).isTrue();
        assertThat(registry.claim("socket-b", "20260813-100500-bbbbbbbb")).isTrue();

        assertThat(ids(registry.snapshot()))
                .containsExactly("20260813-100000-aaaaaaaa", "20260813-100500-bbbbbbbb");
    }

    @Test
    void eachLiveSessionCarriesItsOwnRunningFlag() {
        LiveSessions registry = new LiveSessions();
        registry.claim("socket-a", "session-a");
        registry.claim("socket-b", "session-b");

        registry.running("socket-a", "session-a", true);

        assertThat(registry.snapshot())
                .containsExactly(
                        new LiveSession("session-a", true, registry.snapshot().get(0).since()),
                        new LiveSession("session-b", false, registry.snapshot().get(1).since()));
    }

    @Test
    void oneSessionEndingLeavesTheOtherLive() {
        LiveSessions registry = new LiveSessions();
        registry.claim("socket-a", "session-a");
        registry.claim("socket-b", "session-b");
        registry.running("socket-a", "session-a", true);
        registry.running("socket-b", "session-b", true);

        // a's run finishes AND its socket goes away; b keeps running.
        registry.running("socket-a", "session-a", false);
        registry.release("socket-a");

        assertThat(ids(registry.snapshot())).containsExactly("session-b");
        assertThat(registry.snapshot().get(0).running()).isTrue();
    }

    @Test
    void aRunningFlagFromAnotherSocketIsIgnored() {
        // Only the holder may move its own session's flag: a stray report from
        // a second viewer must not make a quiet session look busy.
        LiveSessions registry = new LiveSessions();
        registry.claim("socket-a", "session-a");

        registry.running("socket-b", "session-a", true);

        assertThat(registry.snapshot().get(0).running()).isFalse();
    }

    @Test
    void aSecondSocketOnOneSessionIdIsRefusedAndTheHolderKeepsIt() {
        LiveSessions registry = new LiveSessions();
        assertThat(registry.claim("socket-a", "session-a")).isTrue();

        assertThat(registry.claim("socket-b", "session-a"))
                .as("the second socket on one session id is refused, never shared")
                .isFalse();

        // The refusal must not disturb the holder: still exactly one row, still a's.
        assertThat(ids(registry.snapshot())).containsExactly("session-a");
        assertThat(registry.holder("session-a")).isEqualTo("socket-a");
    }

    @Test
    void theHolderMayClaimItsOwnSessionAgain() {
        // A resume claims at connect and the store mints again on the first
        // prompt; the same socket asking twice is not a conflict.
        LiveSessions registry = new LiveSessions();
        registry.claim("socket-a", "session-a");

        assertThat(registry.claim("socket-a", "session-a")).isTrue();
        assertThat(registry.snapshot()).hasSize(1);
    }

    @Test
    void releasingTheHolderFreesTheIdForTheNextSocket() {
        LiveSessions registry = new LiveSessions();
        registry.claim("socket-a", "session-a");
        assertThat(registry.claim("socket-b", "session-a")).isFalse();

        registry.release("socket-a");

        assertThat(registry.claim("socket-b", "session-a"))
                .as("a closed socket frees its session — a reload must not lock the operator out")
                .isTrue();
    }

    @Test
    void everyChangePushesTheWholeSnapshotToEveryListener() {
        LiveSessions registry = new LiveSessions();
        Spy first = new Spy();
        Spy second = new Spy();
        registry.addListener(first);
        registry.addListener(second);

        // Registration itself delivers the state of the world, so a page that
        // connects mid-run does not wait for the next change to learn anything.
        assertThat(first.pushes).hasSize(1);
        assertThat(first.latest()).isEmpty();

        // Each mutation is checked at the moment it happens, never only at the
        // end: a registry that pushed on claim and release but stayed silent on
        // a run starting would still look right in a final snapshot, and the
        // pulse everybody is watching for is exactly the one it swallowed.
        registry.claim("socket-a", "session-a");
        assertThat(first.pushes).as("a claim pushes").hasSize(2);
        assertThat(ids(first.latest())).containsExactly("session-a");

        registry.claim("socket-b", "session-b");
        assertThat(first.pushes).as("a second claim pushes").hasSize(3);
        assertThat(ids(first.latest())).containsExactly("session-a", "session-b");

        registry.running("socket-a", "session-a", true);
        assertThat(first.pushes).as("a run starting pushes").hasSize(4);
        assertThat(first.latest().get(0).running()).isTrue();

        registry.release("socket-b");
        assertThat(first.pushes).as("a release pushes").hasSize(5);

        // Both viewers agree, because both were handed the same snapshots.
        assertThat(ids(first.latest())).containsExactly("session-a");
        assertThat(first.latest().get(0).running()).isTrue();
        assertThat(second.pushes).isEqualTo(first.pushes);
    }

    @Test
    void aRemovedListenerStopsBeingPushedTo() {
        LiveSessions registry = new LiveSessions();
        Spy spy = new Spy();
        registry.addListener(spy);
        int afterRegistration = spy.pushes.size();

        registry.removeListener(spy);
        registry.claim("socket-a", "session-a");

        assertThat(spy.pushes).hasSize(afterRegistration);
    }

    @Test
    void aRefusedClaimPushesNothing() {
        // A refusal changes nothing, so it must not wake every browser on the
        // machine — the push is for facts that moved.
        LiveSessions registry = new LiveSessions();
        registry.claim("socket-a", "session-a");
        Spy spy = new Spy();
        registry.addListener(spy);
        int afterRegistration = spy.pushes.size();

        registry.claim("socket-b", "session-a");

        assertThat(spy.pushes).hasSize(afterRegistration);
    }
}
