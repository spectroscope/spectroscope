package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.subagents.RoleCatalog;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 492 on the browser face: the session hands its agent the
 * {@code careParagraph} value the settings hold before every prompt, so a save
 * reaches the next run (reach {@code next-run}); the paragraph names the
 * helpers while the session offers spawn tools and leaves that sentence out
 * when the gear switches the {@code agents} group off; with the key off the
 * agent's base prompt is the v0.14.4 assembly and no paragraph is added; and
 * the System context panel shows what the model gets.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionCareParagraphTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The concept's sentence for two helpers, typed from konzept/RUN-PROFILES.md. */
    private static final String HELPERS_SENTENCE =
            "Start at most 2 subagents at once; more wait for a free slot.";

    private String previousUserSettings;

    @BeforeEach
    void pinTheBackend() throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        previousUserSettings = Files.exists(file) ? Files.readString(file) : null;
        Files.createDirectories(file.getParent());
        Files.writeString(file, "{ \"provider\": \"ollama\", \"model\": \"qwen3:latest\" }");
    }

    @AfterEach
    void restoreTheBackend() throws IOException {
        Path file = SettingsWriter.userSettingsFile();
        if (previousUserSettings == null) {
            Files.deleteIfExists(file);
        } else {
            Files.writeString(file, previousUserSettings);
        }
    }

    private static SessionConnection builtIn(String socketId, Path workspace) {
        SessionConnection connection = new SessionConnection(
                new FakeSocket(socketId, "ws://localhost/ws"), JSON,
                SpectroConfig.load(new SpectroConfig.Overrides(
                        null, null, null, null, null, workspace.toString())), null);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();
        connection.buildAgentOnce();
        return connection;
    }

    private static void writeLocal(Path workspace, String json) throws IOException {
        Path local = workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS);
        Files.createDirectories(local.getParent());
        Files.writeString(local, json);
    }

    @Test
    void withTheKeyOffTheSessionAddsNothingToTheV0144Prompt(@TempDir Path workspace) {
        SessionConnection connection = builtIn("ws-492-off", workspace);
        connection.refreshCareParagraph();
        assertThat(connection.agent().systemPrompt())
                .as("the base prompt is the v0.14.4 assembly")
                .startsWith(RoleCatalog.BASE_SYSTEM_PROMPT + workspace)
                .doesNotContain("Work in small steps.");
        assertThat(connection.agent().careParagraphForNextRun())
                .as("a chat with the key off sends no paragraph")
                .isEmpty();
    }

    @Test
    void aSavedSettingReachesTheNextRunOfAnOpenSession(@TempDir Path workspace) throws IOException {
        SessionConnection connection = builtIn("ws-492-next-run", workspace);
        connection.refreshCareParagraph();
        assertThat(connection.agent().careParagraphForNextRun()).as("premise: off").isEmpty();

        writeLocal(workspace, "{ \"careParagraph\": \"on\" }");
        connection.refreshCareParagraph();

        assertThat(connection.agent().careParagraphForNextRun())
                .as("the session offers spawn tools, so the paragraph names the helpers")
                .startsWith("\n\nThis chat runs with limited capacity")
                .contains(HELPERS_SENTENCE)
                .endsWith("Keep answers short.");
        assertThat(connection.subagents().childCareParagraph())
                .as("before a run, a child starts from the session's value")
                .isEqualTo("off");
    }

    @Test
    void aRealPromptReadsTheSavedSettingAtItsStart(@TempDir Path workspace)
            throws IOException, InterruptedException {
        // The call site in runPrompt, not the method it calls: the test above
        // calls refreshCareParagraph by hand and stays green without it. The
        // backend is a closed port on purpose; the run starts, reads the
        // paragraph and then fails to reach a model, which is all this needs.
        Files.writeString(SettingsWriter.userSettingsFile(),
                "{ \"provider\": \"ollama\", \"model\": \"qwen3:latest\","
                        + " \"baseUrl\": \"http://127.0.0.1:1\" }");
        SessionConnection connection = builtIn("ws-492-callsite", workspace);
        assertThat(connection.agent().careParagraphThisRun()).as("premise: no run yet").isEmpty();

        writeLocal(workspace, "{ \"careParagraph\": \"on\" }");
        connection.onUserMessage("say something", null);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline && connection.agent().careParagraphThisRun().isEmpty()) {
            Thread.sleep(20);
        }

        assertThat(connection.agent().careParagraphThisRun())
                .as("the setting saved between prompts reached the run the next prompt started")
                .contains(HELPERS_SENTENCE);
    }

    @Test
    void theGearsAgentsGroupTakesTheSubagentSentenceOut(@TempDir Path workspace) throws IOException {
        writeLocal(workspace, "{ \"careParagraph\": \"on\" }");
        SessionConnection connection = builtIn("ws-492-agents", workspace);
        connection.refreshCareParagraph();
        assertThat(connection.agent().careParagraphForNextRun()).as("premise").contains(HELPERS_SENTENCE);

        connection.onSetToolGroupsOff(JSON.valueToTree(List.of("agents")));

        assertThat(connection.agent().careParagraphForNextRun())
                .contains("Check each result before the next step.")
                .doesNotContain("subagents");
    }

    @Test
    void theSystemContextPanelShowsTheParagraphTheModelGets(@TempDir Path cwd) throws IOException {
        Path settings = cwd.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{ \"careParagraph\": \"on\" }");
        SpectroConfig on = SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(), cwd, cwd);
        assertThat(on.careParagraph()).as("premise").isEqualTo("on");

        assertThat(ContextDescriber.describe(on, cwd).systemPrompt())
                .contains(HELPERS_SENTENCE)
                .endsWith("Keep answers short.");
        Path plain = Files.createDirectories(cwd.resolve("plain"));
        assertThat(ContextDescriber.describe(SpectroConfig.load(SpectroConfig.Overrides.none(), plain), plain)
                .systemPrompt())
                .as("off: the panel shows no paragraph")
                .doesNotContain("Work in small steps.");
    }
}
