package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The Files tab before the first run. A fresh connection used to announce
 * nothing at all: {@code sendWorkspaceInfo} had three call sites and none of
 * them was connect, so the pane fell back to a sessionless {@code /api/files}
 * and the chooser hardcoded "random" while a configured workspace was what the
 * run would actually use.
 *
 * <p>The announcement is PROSPECTIVE: it names what would happen if you ran
 * now. Naming a folder must not create it and must not mint a session, because
 * the operator can still change the choice.</p>
 */
class SessionConnectionWorkspaceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A config whose workspace is exactly {@code dir}, the flag layer wins over user settings. */
    private static SpectroConfig configuredAt(Path dir) {
        return SpectroConfig.load(
                new SpectroConfig.Overrides(null, null, null, null, null, dir.toString()));
    }

    /** Connects a fresh session (no resume) and returns everything it sent. */
    private static FakeSocket connect(SpectroConfig config) {
        FakeSocket socket = new FakeSocket("ws-1", "ws://localhost/ws");
        new SessionConnection(socket, JSON, config, null).start();
        return socket;
    }

    /** The first workspace frame on the wire, if any. */
    private static Optional<JsonNode> workspaceFrame(FakeSocket socket) {
        synchronized (socket) {
            for (String frame : socket.text) {
                try {
                    JsonNode node = JSON.readTree(frame);
                    if ("workspace_info".equals(node.path("type").asText())) {
                        return Optional.of(node);
                    }
                } catch (Exception notJson) {
                    // provider_info and friends are all JSON; anything else is not ours
                }
            }
        }
        return Optional.empty();
    }

    @Test
    void connectAnnouncesTheProspectiveWorkspaceBeforeAnyRun(@TempDir Path configured) {
        FakeSocket socket = connect(configuredAt(configured));

        assertThat(workspaceFrame(socket))
                .withFailMessage("connect sent no workspace frame, so the pane has nothing to show "
                        + "and falls back to the process cwd")
                .isPresent();
    }

    @Test
    void theProspectiveAnnouncementCreatesNoDirectoryAndMintsNoSession(@TempDir Path parent) {
        // A folder the operator has not committed to yet: they can still pick
        // another one, and resolve() would have created this one regardless.
        Path notYet = parent.resolve("workspace-that-should-not-be-created");

        FakeSocket socket = connect(configuredAt(notYet));

        assertThat(Files.exists(notYet))
                .withFailMessage("connect created the workspace directory; naming a folder must not "
                        + "create it, because the operator can still choose another")
                .isFalse();
        JsonNode frame = workspaceFrame(socket).orElseThrow();
        assertThat(frame.path("sessionId").asText(""))
                .withFailMessage("connect minted a session store just to announce a folder; a tab "
                        + "opened and closed would leave a session behind")
                .isEmpty();
    }

    @Test
    void theAnnouncedModeIsTheModeTheRunWillActuallyUse(@TempDir Path configured) {
        // buildAgentOnce resolves `pinned != null ? pinned : config.workspace()`,
        // so with a configured workspace and nothing pinned the run uses the
        // configured folder. The chooser rendered "random" anyway.
        FakeSocket socket = connect(configuredAt(configured));

        JsonNode frame = workspaceFrame(socket).orElseThrow();
        assertThat(frame.path("resolved").asBoolean(true))
                .withFailMessage("the prospective announcement must say it is not resolved yet")
                .isFalse();
        assertThat(frame.path("mode").asText(""))
                .withFailMessage("a configured workspace is the 'default' mode, not 'random'")
                .isEqualTo("default");
        assertThat(frame.path("path").asText("")).isEqualTo(configured.toString());
    }
}
