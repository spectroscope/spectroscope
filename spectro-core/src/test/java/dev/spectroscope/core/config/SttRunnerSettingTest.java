package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 528, criterion 4: {@code sttRunner} picks what runs whisper on the
 * local live route: {@code auto}, {@code cli} or {@code server}. It ships
 * {@code auto}, is refused with any other value, and every scope can set it.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class SttRunnerSettingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path ws;

    @AfterEach
    void removeUserSettings() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private SpectroConfig loadHere() {
        return SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(),
                ws.resolve("nowhere"), ws);
    }

    @Test
    void theShippedValueIsAuto() {
        assertEquals("auto", SpectroConfig.shippedDefaults().sttRunner());
        assertEquals("auto", SpectroConfig.DEFAULT_STT_RUNNER);
    }

    @Test
    void theThreeValuesAreKnownAndNothingElseIs() {
        assertEquals(Set.of("auto", "cli", "server"), SpectroConfig.KNOWN_STT_RUNNERS);
    }

    @Test
    void theCompatConstructorOfTheLastReleaseShipsAuto() {
        SpectroConfig shipped = SpectroConfig.shippedDefaults();
        SpectroConfig compat = new SpectroConfig(shipped.provider(), shipped.model(), shipped.baseUrl(),
                shipped.compactionThreshold(), shipped.permissionMode(), shipped.autoApprove(),
                shipped.imageProvider(), shipped.thinking(), shipped.mcpServers(), shipped.maxRetries(),
                shipped.promptCaching(), shipped.hooks(), shipped.workspace(), shipped.logLevel(),
                shipped.imageModel(), shipped.sttModel(), shipped.sttProvider(), shipped.sttLanguage(),
                shipped.chromeBinary(), shipped.otlpEndpoint(), shipped.otlpBasicAuth(),
                shipped.ollamaBaseUrl(), shipped.lmstudioBaseUrl(), shipped.searxngUrl(),
                shipped.allowLocalhost(), shipped.headlessMcp(), shipped.progressGuardWrites(),
                shipped.progressGuardFailures(), shipped.progressGuardPlanTurns(),
                shipped.continuationBudget(), shipped.maxTurns(), shipped.llamacppBaseUrl(),
                shipped.questionsPerRun(), shipped.maxQuestionOptions(), shipped.maxQuestionChars(),
                shipped.commandTimeoutSeconds(), shipped.chatReserveWidth(), shipped.dockMaxWidth(),
                shipped.maxTokens(), shipped.subagentBudgetSeconds(), shipped.rtkFilter(),
                shipped.subagentBudgetTokens(), shipped.desktopNotifications(),
                shipped.toolResultElision(), shipped.toolGroupsOff(), shipped.sessionsPerChat(),
                shipped.careParagraph(), shipped.readSharePercent(), shipped.localModeKeys());
        assertEquals("auto", compat.sttRunner());
        assertEquals(shipped, compat, "the 0.15.1 arity builds the shipped config");
    }

    @Test
    void anUnknownValueIsRefusedOnLoadAndTheMessageNamesTheFieldAndTheValues() throws IOException {
        Path settings = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{\"sttRunner\": \"daemon\"}");

        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class, this::loadHere);
        String message = refused.getMessage();
        assertTrue(message.contains("sttRunner") && message.contains("daemon")
                        && message.contains("auto") && message.contains("cli") && message.contains("server"),
                "the message names field, value and the three choices: " + message);
    }

    @Test
    void theSettingsApiRefusesAnUnknownValueAndWritesNothing() {
        Path file = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.PROJECT,
                JSON.createObjectNode().put("sttRunner", "daemon")));
        assertTrue(Files.notExists(file), "a refused patch wrote the file");
    }

    @Test
    void eachOfTheThreeScopesSetsIt() throws IOException {
        List<Path> files = List.of(
                SpectroConfig.USER_SETTINGS_PATH,
                ws.resolve(SpectroConfig.PROJECT_SETTINGS),
                ws.resolve(SpectroConfig.WS_LOCAL_SETTINGS));
        List<SettingsWriter.Scope> scopes = List.of(SettingsWriter.Scope.USER,
                SettingsWriter.Scope.PROJECT, SettingsWriter.Scope.LOCAL);
        for (int i = 0; i < 3; i++) {
            assertEquals("auto", loadHere().sttRunner(),
                    "premise: nothing is set before scope " + scopes.get(i));
            SettingsWriter.patch(files.get(i), scopes.get(i),
                    JSON.createObjectNode().put("sttRunner", "cli"));

            assertEquals("cli", loadHere().sttRunner(),
                    "a save at scope " + scopes.get(i) + " did not reach the loaded config");
            Files.delete(files.get(i));
        }
    }

    @Test
    void theCopiesTheAppDerivesKeepTheRunner() throws IOException {
        Path settings = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{\"sttRunner\": \"server\"}");
        SpectroConfig server = loadHere();
        assertEquals("server", server.sttRunner(), "premise");

        assertEquals("server", server.withProvider("ollama", "some-model").sttRunner());
        assertEquals("server", server.withRtkFilter(SpectroConfig.RTK_FILTER_ON).sttRunner());
        assertEquals("server", server.withDesktopNotifications("off").sttRunner());
        assertEquals("server", server.withToolGroupsOff(List.of("browser")).sttRunner());
    }

    @Test
    void aLocalProviderWithoutAModelKeepsTheRunner() throws IOException {
        // The load rebuilds the config when a local provider names no model.
        Path settings = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{\"provider\": \"ollama\", \"sttRunner\": \"cli\"}");
        assertEquals("cli", loadHere().sttRunner());
    }
}
