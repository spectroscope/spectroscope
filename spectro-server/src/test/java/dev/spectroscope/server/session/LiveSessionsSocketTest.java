package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Two viewers on one home, over real connections.
 *
 * <p>This is the half of card 212 the registry alone cannot prove: that a
 * connection ANNOUNCES the live set to its socket, that a second connection
 * changes what the first one sees, and — the case that was measured rather
 * than theorised on 2026-08-13, when a second client was pointed at the
 * owner's running app and his socket died — that a second viewer arriving on a
 * session somebody already holds is refused WITHOUT touching the holder.</p>
 *
 * <p>The Gradle test task points {@code user.home} into the build directory, so
 * the session files below never touch the real home.</p>
 */
class LiveSessionsSocketTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The live-session push is drained on the connection's own virtual thread. */
    private static final long WAIT_MS = 4000;

    /** A stored session on disk, so {@code ?resume=} has something to load. */
    private static String storedSession() {
        String id = "test-" + UUID.randomUUID().toString().substring(0, 8);
        SessionStore store = new SessionStore(id);
        store.append(new RunEvent.RunStart("r1", "main", null, "hi", null, null, 1L));
        store.append(new RunEvent.RunEnd("r1", "end_turn", 2L));
        return id;
    }

    private static SpectroConfig config() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }

    /** Every frame of the given type this socket has been sent, oldest first. */
    private static List<JsonNode> frames(FakeSocket socket, String type) {
        List<JsonNode> found = new ArrayList<>();
        synchronized (socket) {
            for (String raw : socket.text) {
                try {
                    JsonNode node = JSON.readTree(raw);
                    if (type.equals(node.path("type").asText())) {
                        found.add(node);
                    }
                } catch (Exception notJson) {
                    // every server frame is JSON; anything else is not ours
                }
            }
        }
        return found;
    }

    /** The session ids of the newest live_sessions frame, or null when none arrived. */
    private static List<String> latestLive(FakeSocket socket) {
        List<JsonNode> all = frames(socket, "live_sessions");
        if (all.isEmpty()) {
            return null;
        }
        List<String> ids = new ArrayList<>();
        for (JsonNode row : all.get(all.size() - 1).path("sessions")) {
            ids.add(row.path("id").asText());
        }
        return ids;
    }

    /** Waits until the socket's newest live_sessions frame names exactly these ids. */
    private static void awaitLive(FakeSocket socket, List<String> expected) {
        long deadline = System.currentTimeMillis() + WAIT_MS;
        List<String> seen = null;
        while (System.currentTimeMillis() < deadline) {
            seen = latestLive(socket);
            if (expected.equals(seen)) {
                return;
            }
            Thread.onSpinWait();
        }
        assertThat(seen).as("live_sessions on " + socket.getId()).isEqualTo(expected);
    }

    /** Waits until a frame of this type has been sent, then answers it. */
    private static JsonNode awaitFrame(FakeSocket socket, String type) {
        long deadline = System.currentTimeMillis() + WAIT_MS;
        while (System.currentTimeMillis() < deadline) {
            List<JsonNode> all = frames(socket, type);
            if (!all.isEmpty()) {
                return all.get(all.size() - 1);
            }
            Thread.onSpinWait();
        }
        throw new AssertionError("no " + type + " frame reached " + socket.getId());
    }

    @Test
    void aResumingConnectionIsAnnouncedToTheOtherViewer() {
        LiveSessions registry = new LiveSessions();
        String id = storedSession();

        // A plain viewer with no session of its own — the rail in a second tab.
        FakeSocket watcher = new FakeSocket("ws-watch", "ws://localhost/ws");
        SessionConnection watching =
                new SessionConnection(watcher, JSON, config(), null, null, registry);
        watching.start();
        awaitLive(watcher, List.of());

        // The other face opens the stored session.
        FakeSocket driver = new FakeSocket("ws-drive", "ws://localhost/ws?resume=" + id);
        SessionConnection driving =
                new SessionConnection(driver, JSON, config(), id, null, registry);
        driving.start();

        // Criterion 3: the tab that holds neither socket sees the same truth.
        awaitLive(watcher, List.of(id));
        awaitLive(driver, List.of(id));

        driving.onClose();
        awaitLive(watcher, List.of());
    }

    @Test
    void severalLiveSessionsAreAnnouncedAndOneEndingLeavesTheOther() {
        LiveSessions registry = new LiveSessions();
        String first = storedSession();
        String second = storedSession();

        FakeSocket watcher = new FakeSocket("ws-watch", "ws://localhost/ws");
        new SessionConnection(watcher, JSON, config(), null, null, registry).start();

        FakeSocket a = new FakeSocket("ws-a", "ws://localhost/ws?resume=" + first);
        SessionConnection ca = new SessionConnection(a, JSON, config(), first, null, registry);
        ca.start();
        FakeSocket b = new FakeSocket("ws-b", "ws://localhost/ws?resume=" + second);
        SessionConnection cb = new SessionConnection(b, JSON, config(), second, null, registry);
        cb.start();

        awaitLive(watcher, List.of(first, second));

        // One ends. The other must stay live — the whole point of the card.
        cb.onClose();

        awaitLive(watcher, List.of(first));
        awaitLive(a, List.of(first));
    }

    @Test
    void aSecondSocketOnOneSessionIsRefusedAndTheHolderIsUntouched() {
        LiveSessions registry = new LiveSessions();
        String id = storedSession();

        FakeSocket holder = new FakeSocket("ws-holder", "ws://localhost/ws?resume=" + id);
        SessionConnection held = new SessionConnection(holder, JSON, config(), id, null, registry);
        held.start();
        awaitLive(holder, List.of(id));
        int framesBefore = holder.text.size();

        FakeSocket intruder = new FakeSocket("ws-intruder", "ws://localhost/ws?resume=" + id);
        new SessionConnection(intruder, JSON, config(), id, null, registry).start();

        // The intruder is told why, in a frame of its own, and closed.
        JsonNode busy = awaitFrame(intruder, "session_busy");
        assertThat(busy.path("sessionId").asText()).isEqualTo(id);
        assertThat(intruder.closed.get()).as("the refused socket is closed").isNotNull();

        // The holder keeps the session AND its socket. This is the shape of what
        // actually broke: a second viewer must cost the first one nothing.
        assertThat(registry.holder(id)).isEqualTo("ws-holder");
        assertThat(holder.isOpen()).isTrue();
        assertThat(latestLive(holder)).containsExactly(id);
        assertThat(holder.text.size())
                .as("the refusal sent the holder nothing at all")
                .isEqualTo(framesBefore);
    }

    @Test
    void theRefusedSocketNeverLoadsTheSessionItWasRefused() {
        // A refusal that still built a store would be worse than no refusal:
        // two writers on one JSONL file, quietly.
        LiveSessions registry = new LiveSessions();
        String id = storedSession();

        FakeSocket holder = new FakeSocket("ws-holder", "ws://localhost/ws?resume=" + id);
        new SessionConnection(holder, JSON, config(), id, null, registry).start();
        awaitLive(holder, List.of(id));

        FakeSocket intruder = new FakeSocket("ws-intruder", "ws://localhost/ws?resume=" + id);
        new SessionConnection(intruder, JSON, config(), id, null, registry).start();
        awaitFrame(intruder, "session_busy");

        assertThat(frames(intruder, "workspace_info"))
                .as("a refused connection resolves no workspace for a session it does not hold")
                .isEmpty();
        assertThat(registry.snapshot()).hasSize(1);
    }

    @Test
    void aConnectionWithoutTheRegistryBehavesExactlyAsBefore() {
        // The registry is optional at the seam (like the fleet aggregator), so
        // every existing connection test keeps proving the pre-card behaviour.
        String id = storedSession();
        FakeSocket socket = new FakeSocket("ws-plain", "ws://localhost/ws?resume=" + id);
        new SessionConnection(socket, JSON, config(), id, null).start();

        assertThat(frames(socket, "live_sessions")).isEmpty();
        assertThat(frames(socket, "session_busy")).isEmpty();
        assertThat(socket.isOpen()).isTrue();
    }
}
