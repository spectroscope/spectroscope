package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 453, criteria 1 and 6: {@code extended} is a known permission mode, the
 * user scope may set it, and a workspace scope may not. A workspace file that
 * asks for it loses that one key through the per-key refusal of card 369;
 * {@code ask}, {@code auto} and {@code readonly} from the same file apply as
 * before.
 */
class ExtendedPermissionModeConfigTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @AfterEach
    void removeUserConfig() throws IOException {
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private static void userSettings(String json) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, json);
    }

    private static void workspaceSettings(Path ws, String json) throws IOException {
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), json);
    }

    private static SpectroConfig load(Path projectDir, Path ws) {
        return SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, ws, Map.of());
    }

    // ---------------------------------------------------------------- criterion 1

    @Test
    void extendedIsTheFourthKnownMode() {
        assertEquals(List.of("ask", "auto", "readonly", "extended"),
                SpectroConfig.knownPermissionModes());
        assertTrue(SpectroConfig.KNOWN_PERMISSION_MODES.contains("extended"));
    }

    @Test
    void theUserScopeMaySetExtended(@TempDir Path projectDir, @TempDir Path ws) throws IOException {
        userSettings("{ \"permissionMode\": \"extended\" }");
        assertEquals("extended", load(projectDir, ws).permissionMode());
    }

    @Test
    void anUnknownModeIsStillRefusedAtLoad(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        userSettings("{ \"permissionMode\": \"everything\" }");
        IllegalArgumentException loud = assertThrows(IllegalArgumentException.class,
                () -> load(projectDir, ws));
        assertTrue(loud.getMessage().contains("ask, auto, readonly, extended"), loud.getMessage());
    }

    @Test
    void theWriterAcceptsExtendedInTheUserScope(@TempDir Path home) throws IOException {
        Path file = home.resolve("settings.json");
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.readTree("{\"permissionMode\": \"extended\"}"));
        assertEquals("extended", JSON.readTree(file.toFile()).path("permissionMode").asText());
    }

    @Test
    void theWriterRefusesExtendedInBothWorkspaceScopes(@TempDir Path ws) {
        for (SettingsWriter.Scope scope : List.of(SettingsWriter.Scope.PROJECT, SettingsWriter.Scope.LOCAL)) {
            Path file = ws.resolve(scope + ".json");
            IllegalArgumentException loud = assertThrows(IllegalArgumentException.class,
                    () -> SettingsWriter.patch(file, scope,
                            JSON.readTree("{\"permissionMode\": \"extended\"}")));
            assertTrue(loud.getMessage().contains("extended"), loud.getMessage());
            assertFalse(Files.exists(file), "nothing was written to the " + scope + " scope");
        }
    }

    @Test
    void theWriterStillAcceptsTheOtherModesInTheProjectScope(@TempDir Path ws) throws IOException {
        Path file = ws.resolve(".spectro/settings.json");
        Files.createDirectories(file.getParent());
        for (String mode : List.of("ask", "auto", "readonly")) {
            SettingsWriter.patch(file, SettingsWriter.Scope.PROJECT,
                    JSON.readTree("{\"permissionMode\": \"" + mode + "\"}"));
            assertEquals(mode, JSON.readTree(file.toFile()).path("permissionMode").asText());
        }
    }

    // ---------------------------------------------------------------- criterion 6

    @Test
    void aWorkspaceFileCannotGrantExtended(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        userSettings("{ \"permissionMode\": \"auto\" }");
        workspaceSettings(ws, "{ \"permissionMode\": \"extended\", \"model\": \"m\" }");

        SpectroConfig config = load(projectDir, ws);

        assertEquals("auto", config.permissionMode(), "the user's own setting stays in force");
        assertEquals("m", config.model(), "the file's other keys still apply");
    }

    @Test
    void withoutAUserSettingTheDefaultStays(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        workspaceSettings(ws, "{ \"permissionMode\": \"extended\" }");
        assertEquals("ask", load(projectDir, ws).permissionMode());
    }

    @Test
    void theRefusalIsReportedPerKey(@TempDir Path projectDir, @TempDir Path ws) throws IOException {
        workspaceSettings(ws, "{ \"permissionMode\": \"extended\", \"model\": \"m\" }");

        SpectroConfig.ScopeReport report = SpectroConfig.reportFor(projectDir, ws, Map.of());

        assertEquals(List.of("permissionMode"), report.dropped());
        assertTrue(report.kept().contains("model"), report.kept().toString());
        assertEquals(1, report.refusals().size());
        SpectroConfig.WorkspaceScopeRefused refused = report.refusals().getFirst();
        assertEquals("permissionMode", refused.key());
        assertTrue(refused.getMessage().contains("extended"), refused.getMessage());
    }

    @Test
    void theLocalWorkspaceFileCannotGrantItEither(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(SpectroConfig.WS_LOCAL_SETTINGS),
                "{ \"permissionMode\": \"extended\" }");
        assertEquals("ask", load(projectDir, ws).permissionMode());
    }

    @Test
    void theOtherModesFromAWorkspaceFileApplyAsToday(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        for (String mode : List.of("ask", "auto", "readonly")) {
            workspaceSettings(ws, "{ \"permissionMode\": \"" + mode + "\" }");
            assertEquals(mode, load(projectDir, ws).permissionMode());
            assertTrue(SpectroConfig.reportFor(projectDir, ws, Map.of()).dropped().isEmpty(),
                    mode + " is not refused");
        }
    }

    // ---------------------------------------------------------------- review: launch dir

    private static void launchDirSettings(Path projectDir, String json) throws IOException {
        Files.createDirectories(projectDir.resolve(".spectro"));
        Files.writeString(projectDir.resolve(".spectro/settings.json"), json);
    }

    @Test
    void aLaunchDirFileCannotGrantExtendedWithoutAWorkspace(@TempDir Path projectDir)
            throws IOException {
        // The server's connect config: user.dir as the launch dir, no workspace yet.
        launchDirSettings(projectDir, "{ \"permissionMode\": \"extended\", \"model\": \"m\" }");
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, null, Map.of());
        assertEquals("ask", config.permissionMode());
        assertEquals("m", config.model(), "the file's other keys still apply");
    }

    @Test
    void aLaunchDirFileCannotGrantExtendedBesideAnEmptyWorkspace(@TempDir Path projectDir,
            @TempDir Path ws) throws IOException {
        launchDirSettings(projectDir, "{ \"permissionMode\": \"extended\" }");
        assertEquals("ask", load(projectDir, ws).permissionMode());
    }

    @Test
    void aWorkspaceThatIsAlsoTheLaunchDirCannotGrantExtended(@TempDir Path dir) throws IOException {
        launchDirSettings(dir, "{ \"permissionMode\": \"extended\" }");
        assertEquals("ask", load(dir, dir).permissionMode());
    }

    @Test
    void theLaunchDirRefusalIsReportedPerKey(@TempDir Path projectDir) throws IOException {
        launchDirSettings(projectDir, "{ \"permissionMode\": \"extended\" }");
        SpectroConfig.ScopeReport report = SpectroConfig.reportFor(projectDir, null, Map.of());
        assertEquals(List.of("permissionMode"), report.dropped());
        assertEquals(projectDir.resolve(".spectro/settings.json").toString(), report.file());
    }

    @Test
    void theOtherModesFromTheLaunchDirApplyAsToday(@TempDir Path projectDir) throws IOException {
        for (String mode : List.of("ask", "auto", "readonly")) {
            launchDirSettings(projectDir, "{ \"permissionMode\": \"" + mode + "\" }");
            assertEquals(mode, SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, null,
                    Map.of()).permissionMode());
            assertTrue(SpectroConfig.reportFor(projectDir, null, Map.of()).dropped().isEmpty(), mode);
        }
    }

    @Test
    void theUserScopeStillGrantsExtendedWhenTheLaunchDirSaysItToo(@TempDir Path projectDir)
            throws IOException {
        userSettings("{ \"permissionMode\": \"extended\" }");
        launchDirSettings(projectDir, "{ \"permissionMode\": \"extended\" }");
        assertEquals("extended", SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, null,
                Map.of()).permissionMode());
    }
}
