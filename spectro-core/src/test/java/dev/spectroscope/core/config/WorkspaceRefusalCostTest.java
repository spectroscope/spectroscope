package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 354: a workspace-scope refusal says whether it COSTS the operator
 * anything.
 *
 * <p>The refusal itself is correct and untouched (card 199, card 222). What it
 * could not say is whether the key it dropped is carried anyway from a scope
 * that IS allowed to carry it. On the owner's machine it is: {@code ForgeDemo}'s
 * workspace scope sets {@code allowLocalhost} and is refused, while
 * {@code ~/.spectro/settings.json} already sets the same key at the scope where
 * it counts. The refusal was therefore a true sentence with no consequence,
 * occupying the first line of an empty session.</p>
 *
 * <p><b>In force means the same VALUE, not merely the same key.</b> A user scope
 * that sets {@code allowLocalhost: false} while the workspace asks for
 * {@code true} is the expensive case, not the free one — a reading that only
 * asked "does some allowed scope name this key" would call it free and be
 * exactly backwards.</p>
 */
class WorkspaceRefusalCostTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @AfterEach
    void removeUserConfig() throws IOException {
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private static void writeUserSettings(String json) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, json);
    }

    private static void writeWorkspaceSettings(Path ws, String json) throws IOException {
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), json);
    }

    private static SpectroConfig.WorkspaceScopeRefused refusalFrom(
            Path projectDir, Path ws, Map<String, String> env) {
        return assertThrows(SpectroConfig.WorkspaceScopeRefused.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, ws, env));
    }

    @Test
    void aKeyTheUserScopeAlreadyCarriesCostsNothing(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // The owner's own machine, reproduced: the workspace folder asks for the
        // net fence's opt-in and is refused, and ~/.spectro already granted it.
        writeUserSettings("""
                { "allowLocalhost": true }
                """);
        writeWorkspaceSettings(ws, """
                { "allowLocalhost": true }
                """);

        SpectroConfig.WorkspaceScopeRefused refused = refusalFrom(projectDir, ws, Map.of());

        assertEquals("allowLocalhost", refused.key());
        assertEquals(Boolean.TRUE, refused.inForce(),
                "the refused key is carried anyway, so the refusal costs nothing");
        assertEquals("user", refused.inForceFrom(),
                "and the reading names the scope that carries it");
    }

    @Test
    void aKeyNothingElseCarriesIsTheExpensiveCase(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // The case that IS worth interrupting for: the operator asked for
        // something, the folder was the wrong place to ask, and nobody else asks.
        writeWorkspaceSettings(ws, """
                { "allowLocalhost": true }
                """);

        SpectroConfig.WorkspaceScopeRefused refused = refusalFrom(projectDir, ws, Map.of());

        assertEquals(Boolean.FALSE, refused.inForce(),
                "nothing above the defaults carries it, so the operator is losing it");
        assertNull(refused.inForceFrom(), "and there is no scope to name");
    }

    @Test
    void anAllowedScopeCarryingTheOPPOSITEValueIsNotInForce(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // The reading that separates a real answer from a cheap one. A check of
        // the shape "does any allowed scope mention this key" is GREEN here, and
        // wrong: the user scope mentions allowLocalhost in order to switch it
        // OFF, so the workspace's request is being lost, not honoured.
        writeUserSettings("""
                { "allowLocalhost": false }
                """);
        writeWorkspaceSettings(ws, """
                { "allowLocalhost": true }
                """);

        SpectroConfig.WorkspaceScopeRefused refused = refusalFrom(projectDir, ws, Map.of());

        assertEquals(Boolean.FALSE, refused.inForce(),
                "the user scope carries the key at the OTHER value — that is a loss, not a free pass");
        assertNull(refused.inForceFrom());
    }

    @Test
    void theEnvironmentIsAScopeThatCanCarryIt(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // The hint the refusal prints names the env var by name
        // ("~/.spectro/settings.json or SPECTRO_ALLOW_LOCALHOST"), so an operator
        // who took the second half of that advice must not then be told the key
        // is not in force.
        writeWorkspaceSettings(ws, """
                { "allowLocalhost": true }
                """);

        SpectroConfig.WorkspaceScopeRefused refused =
                refusalFrom(projectDir, ws, Map.of("SPECTRO_ALLOW_LOCALHOST", "true"));

        assertEquals(Boolean.TRUE, refused.inForce());
        assertEquals("env", refused.inForceFrom());
    }

    @Test
    void theHIGHESTCarryingScopeIsTheOneNamed(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // Two allowed scopes carry it; the one that actually decides is the
        // higher. Reporting "env" here would send the operator to edit a layer
        // whose value is being overridden anyway.
        Files.createDirectories(projectDir.resolve(".spectro"));
        Files.writeString(projectDir.resolve(".spectro/settings.json"), """
                { "allowLocalhost": true }
                """);
        writeWorkspaceSettings(ws, """
                { "allowLocalhost": true }
                """);

        SpectroConfig.WorkspaceScopeRefused refused =
                refusalFrom(projectDir, ws, Map.of("SPECTRO_ALLOW_LOCALHOST", "true"));

        assertEquals("launch-dir", refused.inForceFrom(),
                "the fold is ascending, so the last scope to set it is the one in force");
    }

    @Test
    void aCommandLineFlagCountsAsAScopeThatCarriesIt(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // The flags layer is built before the refusal runs precisely so it can
        // answer this, and nothing else in the suite would notice if it were
        // left out of the allowed chain: --workspace is the very flag that
        // resolved the folder now asking for "workspace" in its own settings.
        writeWorkspaceSettings(ws, JSON.writeValueAsString(Map.of("workspace", ws.toString())));

        SpectroConfig.WorkspaceScopeRefused refused = assertThrows(
                SpectroConfig.WorkspaceScopeRefused.class,
                () -> SpectroConfig.load(new SpectroConfig.Overrides(
                        null, null, null, null, null, ws.toString()), projectDir, ws, Map.of()));

        assertEquals("workspace", refused.key());
        assertEquals(Boolean.TRUE, refused.inForce());
        assertEquals("flags", refused.inForceFrom(),
                "the command line is above every settings file, so it is what carries the key");
    }

    @Test
    void aLowerScopeThatAgreesDoesNotSurviveAHigherOneThatDoesNot(
            @TempDir Path projectDir, @TempDir Path ws) throws IOException {
        // Found by biting: a walk that only ever REMEMBERS an agreeing layer is
        // green on every test above, and wrong here. The operator switched the
        // fence on in the environment and back off in ~/.spectro; the user scope
        // wins the fold, so the workspace's request is lost — and a notice
        // reading "already in force from env" would send him to fix the one
        // layer that is not the problem.
        writeUserSettings("""
                { "allowLocalhost": false }
                """);
        writeWorkspaceSettings(ws, """
                { "allowLocalhost": true }
                """);

        SpectroConfig.WorkspaceScopeRefused refused =
                refusalFrom(projectDir, ws, Map.of("SPECTRO_ALLOW_LOCALHOST", "true"));

        assertEquals(Boolean.FALSE, refused.inForce(),
                "the highest carrying layer sets it the other way, so it is not in force");
        assertNull(refused.inForceFrom(),
                "and the layer that agreed is shadowed, so naming it would be a wrong address");
    }

    @Test
    void theLocalHalfOfTheWorkspaceScopeAnswersTheSameQuestion(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // settings.local.json is written by the same hand and refused by the
        // same rule; card 285's own test pins the message, this pins the reading.
        writeUserSettings("""
                { "chromeBinary": "/usr/bin/chromium" }
                """);
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.local.json"), """
                { "chromeBinary": "/usr/bin/chromium" }
                """);

        SpectroConfig.WorkspaceScopeRefused refused = refusalFrom(projectDir, ws, Map.of());

        assertEquals("chromeBinary", refused.key());
        assertTrue(refused.file().endsWith("settings.local.json"), refused.file());
        assertEquals(Boolean.TRUE, refused.inForce());
        assertEquals("user", refused.inForceFrom());
    }

    // ---- coverage: every forbidden key, derived from the source ------------------

    /**
     * Every key on the refusal list gets a real reading, and the list is read
     * from the source rather than typed here.
     *
     * <p>Card 354, criterion 3, and the board's own lesson about hand lists: a
     * list guarded by a test that types the same list is two copies of one lie.
     * So the keys come from {@link SpectroConfig#workspaceScopeForbiddenKeys()},
     * and the VALUE written for each one comes from the record component's
     * declared type — a key whose name is not a real settings key fails here on
     * the lookup, before any assertion runs, which is exactly the drift a typo
     * in a {@code ProcessGlobal} would otherwise cause (the fence refuses the
     * load, the reading probes a field nobody named, and the notice reports
     * "not in force" forever).</p>
     */
    @Test
    void everyForbiddenKeyAnswersBothHalvesOfTheQuestion(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        List<String> keys = SpectroConfig.workspaceScopeForbiddenKeys();
        assertFalse(keys.isEmpty(), "the refusal list is empty — nothing is being guarded");

        for (String key : keys) {
            Object sample = sampleValueFor(key);

            // Carried by an allowed scope at the same value: free.
            writeUserSettings(JSON.writeValueAsString(Map.of(key, sample)));
            writeWorkspaceSettings(ws, JSON.writeValueAsString(Map.of(key, sample)));
            SpectroConfig.WorkspaceScopeRefused free = refusalFrom(projectDir, ws, Map.of());
            assertEquals(key, free.key(),
                    "a scope that sets only \"" + key + "\" must be refused for that key");
            assertEquals(Boolean.TRUE, free.inForce(), "\"" + key + "\" is carried by the user scope");
            assertEquals("user", free.inForceFrom(), "\"" + key + "\"");

            // Carried by nobody: expensive.
            Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
            SpectroConfig.WorkspaceScopeRefused lost = refusalFrom(projectDir, ws, Map.of());
            assertEquals(Boolean.FALSE, lost.inForce(),
                    "\"" + key + "\" is carried by nobody and the reading must say so");
            assertNull(lost.inForceFrom(), "\"" + key + "\"");
        }
    }

    /**
     * A settings value of the right shape for one key, taken from
     * {@link SpectroConfig}'s own record component — never a table in this file.
     *
     * @param key the settings key
     * @return a JSON-writable value Jackson will bind to that field
     */
    private static Object sampleValueFor(String key) {
        for (RecordComponent component : SpectroConfig.class.getRecordComponents()) {
            if (!component.getName().equals(key)) {
                continue;
            }
            Class<?> type = component.getType();
            if (type == boolean.class || type == Boolean.class) {
                return Boolean.TRUE;
            }
            if (type == int.class || type == Integer.class) {
                return 7;
            }
            if (type == String.class) {
                return "card-354-" + key;
            }
            throw new AssertionError("no sample value for " + key + " of type " + type);
        }
        throw new AssertionError("\"" + key + "\" is on the workspace-scope refusal list but is not a"
                + " SpectroConfig record component — the refusal probes a field no settings file"
                + " can name, so its cost reading can never be anything but \"not in force\"");
    }

    @Test
    void theListedKeysAreDistinctAndTheReadingIsPerKey(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // Two forbidden keys in one file: the refusal names the first one
        // checked, and the reading belongs to THAT key and not to its neighbour.
        // A reading wired to the wrong probe is green whenever both keys happen
        // to agree, which the loop above cannot see.
        writeUserSettings("""
                { "allowLocalhost": true }
                """);
        Map<String, Object> both = new LinkedHashMap<>();
        both.put("logLevel", "debug");
        both.put("allowLocalhost", true);
        writeWorkspaceSettings(ws, JSON.writeValueAsString(both));

        SpectroConfig.WorkspaceScopeRefused refused = refusalFrom(projectDir, ws, Map.of());

        assertEquals("logLevel", refused.key(), "the list is checked in order and logLevel comes first");
        assertEquals(Boolean.FALSE, refused.inForce(),
                "the reading answers for logLevel, which nothing else sets — not for its"
                        + " neighbour allowLocalhost, which the user scope does set");
        assertNull(refused.inForceFrom());
    }

    @Test
    void theRefusalMessageIsUnchanged(@TempDir Path projectDir, @TempDir Path ws) throws IOException {
        // Criterion 4: this card moves a message, it does not soften a guard.
        // The whole sentence card 285 shipped stays byte-identical, so every
        // surface that reads it still reads what it read yesterday.
        writeUserSettings("""
                { "allowLocalhost": true }
                """);
        writeWorkspaceSettings(ws, """
                { "allowLocalhost": true }
                """);

        SpectroConfig.WorkspaceScopeRefused refused = refusalFrom(projectDir, ws, Map.of());

        assertEquals("\"allowLocalhost\" is process-global and not allowed in a workspace scope ("
                        + ws.resolve(".spectro/settings.json") + ") — the net fence's opt-in belongs"
                        + " in ~/.spectro/settings.json or SPECTRO_ALLOW_LOCALHOST, not in a folder"
                        + " the agent writes into.",
                refused.getMessage());
        assertNotNull(refused.hint());
    }
}
