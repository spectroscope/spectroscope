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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * One forbidden key costs that key, not the file (card 369).
 *
 * <p>THE OWNER'S OWN FILE, and it is the fixture below verbatim. On 2026-09-01
 * {@code ~/ForgeDemo/.spectro/settings.json} held</p>
 *
 * <pre>{ "permissionMode": "auto", "allowLocalhost": true }</pre>
 *
 * <p>{@code allowLocalhost} is one of NINE process-global keys out of 39 that a
 * workspace scope may not set, so the whole file was refused — and
 * {@code permissionMode}, which a workspace scope IS allowed to carry, went
 * with it. He set {@code auto} and his runs asked. He reported it twice before
 * anybody measured what it cost him.</p>
 *
 * <p><b>Card 354 is not at fault and this file does not touch it.</b> Its
 * pricing walks every field of the refused scope rather than only the offending
 * one, and it spoke here because there was a real loss. It did its job; the
 * rule it reported was harsher than it needed to be.</p>
 *
 * <p>What does NOT move: all nine keys stay forbidden in a workspace scope, and
 * {@code workspaceScopeForbiddenKeys()} stays the single source that both this
 * reader and {@code SettingsWriter} consult. This card drops the key and keeps
 * the file; it does not let a project folder change the process.</p>
 */
class PerKeyRefusalTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @AfterEach
    void removeUserConfig() throws IOException {
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private static void writeWorkspaceSettings(Path ws, String json) throws IOException {
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), json);
    }

    private static SpectroConfig load(Path projectDir, Path ws) {
        return SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, ws, Map.of());
    }

    @Test
    void theLegalKeyStillAppliesWhenAForbiddenOneStandsBesideIt(
            @TempDir Path projectDir, @TempDir Path ws) throws IOException {
        // The owner's file, verbatim. Before this card `load` threw and both keys
        // were lost; the whole point is that exactly one of them is.
        writeWorkspaceSettings(ws, """
                { "permissionMode": "auto", "allowLocalhost": true }
                """);

        SpectroConfig config = load(projectDir, ws);

        assertEquals("auto", config.permissionMode(),
                "permissionMode is workspace-settable and must survive its neighbour");
        assertFalse(config.allowLocalhost(),
                "and the forbidden key must NOT take effect — the rule itself does not move");
    }

    @Test
    void everyOneOfTheNineIsStillRefused(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // DERIVED from the list, not typed: a tenth process-global key added to
        // WORKSPACE_SCOPE_FORBIDDEN must be refused here without this test being
        // edited. A hand-list guarded by a test typing the same hand-list is two
        // copies of one truth, which is the defect this house keeps finding.
        List<String> forbidden = SpectroConfig.workspaceScopeForbiddenKeys();
        assertTrue(forbidden.size() >= 9, "the list is the source: " + forbidden);
        for (String key : forbidden) {
            if ("workspace".equals(key)) {
                continue; // circular by nature; its own refusal is pinned elsewhere
            }
            // A value of the RIGHT TYPE, derived from the record component rather
            // than from a table typed here: the nine span booleans, ints and
            // strings, and a fixture that guessed would fail as a malformed file
            // and look exactly like the refusal it is meant to test.
            writeWorkspaceSettings(ws, "{\"permissionMode\": \"auto\", \""
                    + key + "\": " + sampleFor(key) + "}");
            SpectroConfig config = load(projectDir, ws);
            assertEquals("auto", config.permissionMode(),
                    "the legal key survives beside forbidden \"" + key + "\"");
        }
    }

    /** A JSON literal of the type {@code key}'s record component holds.
     *  @param key the settings key
     *  @return the literal, ready to paste into a settings file */
    private static String sampleFor(String key) {
        for (var component : SpectroConfig.class.getRecordComponents()) {
            if (!component.getName().equals(key)) {
                continue;
            }
            Class<?> type = component.getType();
            if (type == boolean.class || type == Boolean.class) {
                return "true";
            }
            if (type == int.class || type == Integer.class) {
                return "1";
            }
            return "\"x\"";
        }
        throw new IllegalStateException("no record component named " + key);
    }

    @Test
    void aFileWithNoForbiddenKeyIsUntouched(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // The other direction. A change that dropped keys too eagerly would pass
        // the first case and quietly break every ordinary workspace file.
        writeWorkspaceSettings(ws, """
                { "permissionMode": "readonly", "model": "some-model" }
                """);

        SpectroConfig config = load(projectDir, ws);

        assertEquals("readonly", config.permissionMode());
        assertEquals("some-model", config.model());
    }

    @Test
    void theNoticeNamesWhatItDroppedAndWhatItKept(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // Criterion 2. The sentence he read explained the RULE — "a workspace
        // folder may not set it, so the whole file is dropped" — and never named
        // the setting he actually lost. That is why he came back a second time.
        writeWorkspaceSettings(ws, """
                { "permissionMode": "auto", "allowLocalhost": true, "model": "m" }
                """);

        SpectroConfig.ScopeReport report = SpectroConfig.reportFor(projectDir, ws, Map.of());

        assertEquals(List.of("allowLocalhost"), report.dropped(),
                "it names the key it refused");
        assertTrue(report.kept().contains("permissionMode") && report.kept().contains("model"),
                "and the ones it kept, so the reader can see the file still did something: "
                        + report.kept());
    }

    @Test
    void aRefusedWriteSaysWhatAReadOfSuchAFileWouldDo(@TempDir Path ws) throws IOException {
        // Criterion 5, and the decision it demanded: WRITING stays
        // all-or-nothing, READING became per key, and the two do not disagree
        // because the refusal message says so. A patch has not landed yet, so
        // refusing it entire costs one correction; a file on disk has landed,
        // and refusing it entire costs keys typed correctly.
        //
        // Derived from the list, not typed, for the same reason as the walk
        // above: a tenth process-global key must be covered here without this
        // test being edited.
        Path file = ws.resolve(".spectro/settings.json");
        Files.createDirectories(file.getParent());
        for (String key : SpectroConfig.workspaceScopeForbiddenKeys()) {
            IllegalArgumentException loud = assertThrows(IllegalArgumentException.class,
                    () -> SettingsWriter.patch(file, SettingsWriter.Scope.PROJECT,
                            JSON.readTree("{\"model\": \"m\", \"" + key + "\": \"x\"}")));
            assertTrue(loud.getMessage().contains("Nothing in this patch was written"),
                    "the write is all-or-nothing and must say so: " + loud.getMessage());
            assertTrue(loud.getMessage().contains("alone is skipped"),
                    "and it must say what a READ of such a file does, or an operator who"
                            + " meets both is told two different things: " + loud.getMessage());
        }
        assertFalse(Files.exists(file),
                "all-or-nothing is the behaviour, not only the sentence: the legal key"
                        + " beside the forbidden one was not written either");
    }

    @Test
    void bothWorkspaceScopesAreReported__neitherFileGoesUnmentioned(@TempDir Path projectDir,
            @TempDir Path ws) throws IOException {
        // A workspace has TWO scopes, and an earlier draft of this card kept
        // only the first non-empty report — `project.isEmpty() ? local : project`
        // — which silently drops the local file's refusal whenever both files
        // have one. Telling an operator about one of his two files is the same
        // defect the card was cut to fix, one level up.
        writeWorkspaceSettings(ws, """
                { "permissionMode": "auto", "allowLocalhost": true }
                """);
        Files.writeString(ws.resolve(SpectroConfig.WS_LOCAL_SETTINGS), """
                { "model": "m", "logLevel": "debug" }
                """);

        List<SpectroConfig.ScopeReport> reports = SpectroConfig
                .loadResolved(SpectroConfig.Overrides.none(), projectDir, ws, Map.of())
                .reports().stream().filter(r -> !r.isEmpty()).toList();

        assertEquals(2, reports.size(), "both files gave something up, so both are reported");
        assertEquals(List.of("allowLocalhost"), reports.get(0).dropped());
        assertEquals(List.of("logLevel"), reports.get(1).dropped());
        SpectroConfig config = load(projectDir, ws);
        assertEquals("auto", config.permissionMode(), "and each file keeps its legal keys");
        assertEquals("m", config.model());
    }
}
