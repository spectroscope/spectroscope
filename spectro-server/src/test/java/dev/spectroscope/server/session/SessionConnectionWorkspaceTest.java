package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.session.SessionStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
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

    /**
     * Card 284: a resume must land in the folder its own record names, not in
     * the configured default. Measured 2026-08-19 on session
     * {@code 20260819-160135-b651423f}: the original run worked in
     * {@code particle_Stephan_deepseek} and the resume worked in
     * {@code ForgeDemo}, the global default, because a restart had dropped the
     * in-memory pin and nothing in the record carried the folder. The agent
     * then read a CLAUDE.md and a folder that were not the ones it resumed,
     * and said nothing about the swap.
     */
    @Test
    void aResumeNamesTheFolderItsRecordCarriesRatherThanTheDefault(
            @TempDir Path recorded, @TempDir Path configured) throws IOException {
        String id = "card284-resume";
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Map<String, Object> runStart = new LinkedHashMap<>();
        runStart.put("type", "run_start");
        runStart.put("runId", "run-284");
        runStart.put("agentId", "main");
        runStart.put("prompt", "look at the folder");
        runStart.put("workspace", recorded.toString());
        runStart.put("ts", 1L);
        Files.writeString(SessionStore.SESSIONS_DIR.resolve(id + ".jsonl"),
                JSON.writeValueAsString(runStart) + "\n");

        FakeSocket socket = new FakeSocket("ws-284", "ws://localhost/ws");
        new SessionConnection(socket, JSON, configuredAt(configured), id).start();

        JsonNode frame = workspaceFrame(socket)
                .orElseThrow(() -> new AssertionError("a resume announces no workspace at all"));
        assertThat(Path.of(frame.path("path").asText()).toRealPath())
                .as("the resume must name the folder its record carries, not the default")
                .isEqualTo(recorded.toRealPath());
    }

    /** Writes a stored session whose run_start records {@code folder}. */
    private static void recordSession(String id, String folder) throws IOException {
        Files.createDirectories(SessionStore.SESSIONS_DIR);
        Map<String, Object> runStart = new LinkedHashMap<>();
        runStart.put("type", "run_start");
        runStart.put("runId", "run-" + id);
        runStart.put("agentId", "main");
        runStart.put("prompt", "look at the folder");
        runStart.put("workspace", folder);
        runStart.put("ts", 1L);
        Files.writeString(SessionStore.SESSIONS_DIR.resolve(id + ".jsonl"),
                JSON.writeValueAsString(runStart) + "\n");
    }

    /**
     * Card 284: the mode must name where the folder came from. Once a resume
     * can be answered from the record, reporting "default" would be a lie the
     * chooser then pre-selects.
     */
    @Test
    void aResumeAnsweredFromTheRecordSaysSoInItsMode(
            @TempDir Path recorded, @TempDir Path configured) throws IOException {
        recordSession("card284-mode", recorded.toString());

        FakeSocket socket = new FakeSocket("ws-284-mode", "ws://localhost/ws");
        new SessionConnection(socket, JSON, configuredAt(configured), "card284-mode").start();

        assertThat(workspaceFrame(socket).orElseThrow().path("mode").asText())
                .as("the mode names the record as the source, not the default")
                .isEqualTo("recorded");
    }

    /**
     * Card 284, criterion 3: a recorded folder that is gone must not be
     * silently recreated. {@code WorkspaceResolver.resolve} calls
     * {@code Files.createDirectories}, so without this the resume would mint an
     * EMPTY directory at the old path and hand the agent a project that is not
     * there. Falling back is fine; falling back in silence is not.
     */
    @Test
    void aRecordedFolderThatIsGoneIsNamedRatherThanRecreated(
            @TempDir Path parent, @TempDir Path configured) throws IOException {
        Path vanished = parent.resolve("deleted-project");
        recordSession("card284-gone", vanished.toString());

        FakeSocket socket = new FakeSocket("ws-284-gone", "ws://localhost/ws");
        new SessionConnection(socket, JSON, configuredAt(configured), "card284-gone").start();

        JsonNode frame = workspaceFrame(socket).orElseThrow();
        assertThat(Files.exists(vanished))
                .as("a folder the record names but that is gone must not be recreated")
                .isFalse();
        assertThat(frame.path("unavailable").asText())
                .as("the frame names the folder it wanted and could not use")
                .isEqualTo(vanished.toString());
        assertThat(Path.of(frame.path("path").asText()).toRealPath())
                .as("and it falls back to the configured folder")
                .isEqualTo(configured.toRealPath());
    }
}
