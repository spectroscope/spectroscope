package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.lang.reflect.Method;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 453, criteria 1, 2 and 5 at the server: the live switch knows
 * {@code extended} from the core list, the gate answers it like {@code auto}
 * and names it in the audit label, and the broker opens the file fence only
 * while the live mode is {@code extended}.
 */
class ExtendedModeSwitchTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static PermissionRequest request(String name) {
        return new PermissionRequest("main", "call-453", name, JSON.createObjectNode(), 1L);
    }

    private record Wired(SessionConnection connection, FakeSocket socket, PermissionBroker broker) {
    }

    private static Wired wire(Path workspace) throws Exception {
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", "http://127.0.0.1:9", null, null, workspace.toString()));
        FakeSocket socket = new FakeSocket("ws-453", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        Method method = SessionConnection.class.getDeclaredMethod("parkingBroker");
        method.setAccessible(true);
        return new Wired(connection, socket, (PermissionBroker) method.invoke(connection));
    }

    @Test
    void extendedApprovesEveryGatedCallLikeAuto() {
        assertEquals(Boolean.TRUE, PermissionModes.decide("extended", request("run_command")));
        assertEquals(Boolean.TRUE, PermissionModes.decide("extended", request("write_file")));
        assertEquals(Boolean.TRUE, PermissionModes.verdictOf("mode:extended"));
    }

    @Test
    void theSwitchAcceptsEveryKnownModeAndNothingElse(@TempDir Path workspace) throws Exception {
        Wired wired = wire(workspace);
        for (String mode : SpectroConfig.knownPermissionModes()) {
            wired.connection().onSetPermissionMode(mode);
            assertFalse(wired.socket().textJoined().contains("Unknown permission mode"),
                    "the switch refused a mode the core knows: " + mode);
        }
        wired.connection().onSetPermissionMode("everything");
        assertTrue(wired.socket().textJoined().contains(
                "(allowed: " + String.join(", ", SpectroConfig.knownPermissionModes()) + ")"),
                wired.socket().textJoined());
    }

    @Test
    void theGateStampsAndAuditsTheModeExtended(@TempDir Path workspace) throws Exception {
        Wired wired = wire(workspace);
        wired.connection().onSetPermissionMode("extended");
        assertEquals("mode:extended", wired.broker().decidedBy(request("run_command")));
        assertTrue(wired.broker().decide(request("run_command").stamped("mode:extended")));
    }

    @Test
    void theFenceFollowsTheLiveMode(@TempDir Path workspace) throws Exception {
        Wired wired = wire(workspace);
        assertFalse(wired.broker().reachesOutsideTheWorkingDirectory(), "ask by default: fenced");
        wired.connection().onSetPermissionMode("extended");
        assertTrue(wired.broker().reachesOutsideTheWorkingDirectory(), "extended opens it");
        wired.connection().onSetPermissionMode("ask");
        assertFalse(wired.broker().reachesOutsideTheWorkingDirectory(),
                "switching back to ask closes it for the next call");
        for (String mode : new String[] {"auto", "readonly"}) {
            wired.connection().onSetPermissionMode(mode);
            assertFalse(wired.broker().reachesOutsideTheWorkingDirectory(), mode + " keeps the fence");
        }
    }

    // ---------------------------------------------------------------- review: launch dir

    @Test
    void aServerStartedInsideARepoThatAsksForExtendedDoesNotComeUpExtended(@TempDir Path repo)
            throws Exception {
        java.nio.file.Files.createDirectories(repo.resolve(".spectro"));
        java.nio.file.Files.writeString(repo.resolve(".spectro/settings.json"),
                "{ \"permissionMode\": \"extended\" }");
        // What SpectroSocketHandler builds at connect: the launch dir, no workspace yet.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), repo);
        assertEquals("ask", config.permissionMode());
        FakeSocket socket = new FakeSocket("ws-453-launch", "ws://localhost/ws");
        SessionConnection connection = new SessionConnection(socket, JSON, config, null);
        Method method = SessionConnection.class.getDeclaredMethod("parkingBroker");
        method.setAccessible(true);
        PermissionBroker broker = (PermissionBroker) method.invoke(connection);
        assertFalse(broker.reachesOutsideTheWorkingDirectory(), "the connect config must stay fenced");
    }

    @Test
    void theLaunchDirRefusalReachesTheSessionAsSettingsIgnored(@TempDir Path repo) throws Exception {
        java.nio.file.Files.createDirectories(repo.resolve(".spectro"));
        java.nio.file.Files.writeString(repo.resolve(".spectro/settings.json"),
                "{ \"permissionMode\": \"extended\" }");
        Wired wired = wire(repo);
        java.lang.reflect.Field projectDir = SessionConnection.class.getDeclaredField("projectDir");
        projectDir.setAccessible(true);
        projectDir.set(wired.connection(), repo);
        java.lang.reflect.Field workspace = SessionConnection.class.getDeclaredField("workspace");
        workspace.setAccessible(true);
        workspace.set(wired.connection(), repo);

        SpectroConfig live = wired.connection().liveConfig();

        assertEquals("ask", live.permissionMode(), "workspace == launch dir: the unstripped copy must not win");
        String frames = wired.socket().textJoined();
        assertTrue(frames.contains("\"settings_ignored\"") && frames.contains("\"permissionMode\""),
                "the launch dir's refusal is told like a workspace one: " + frames);
    }
}
