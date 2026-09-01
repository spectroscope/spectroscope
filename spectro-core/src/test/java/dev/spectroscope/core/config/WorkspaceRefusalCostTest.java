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
 * could not say is whether anything it dropped is carried anyway from a scope
 * that IS allowed to carry it.</p>
 *
 * <p><b>The question is about the FILE, not about the key that tripped it.</b>
 * The loader leaves on the first forbidden key and abandons the whole workspace
 * scope, so every other setting in that file is dropped too. The owner's
 * {@code ForgeDemo} scope is the case that settles it: it asks for
 * {@code allowLocalhost}, which {@code ~/.spectro/settings.json} carries anyway,
 * and for {@code permissionMode "auto"}, which nothing else sets. Priced per key
 * that refusal reads as free, and a surface that keeps a free notice off the
 * screen then says nothing while he loses his permission mode.</p>
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

    /**
     * The refusal this read produced.
     *
     * <p>CARD 369 changed where it comes from and nothing else. It used to be
     * thrown, taking the whole workspace file with it; now the forbidden key is
     * dropped, the file's legal keys apply, and the refusal is a VALUE on the
     * scope report. Every assertion in this file is about the refusal's own
     * content — the key, the hint, whether it costs the operator anything and
     * which scope carries it anyway — and all of that is unchanged, which is why
     * this file keeps its cases instead of being rewritten around a new idea.</p>
     *
     * @param projectDir the launch directory
     * @param ws         the workspace whose scope is refused
     * @param env        the environment layer
     * @return the single refusal that read produced
     */
    private static SpectroConfig.WorkspaceScopeRefused refusalFrom(
            Path projectDir, Path ws, Map<String, String> env) {
        return SpectroConfig.reportFor(projectDir, ws, env).only();
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
    void aFileThatAlsoSetsSomethingElseIsNotFree(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // REPLACED by card 369, not loosened, and the fixture is why. This IS
        // the owner's ForgeDemo file, read on 2026-08-31: it asks for
        // allowLocalhost, which ~/.spectro carries anyway, and for
        // permissionMode "auto", which nothing else sets.
        //
        // Card 354 demanded FALSE here, and was right to: the refusal took the
        // whole file, so his permission mode went down with it and a reading
        // that priced only the key that tripped the refusal would have let the
        // chat stay silent while he lost it. Card 369 stopped the file from
        // going. permissionMode reaches the run now — this very test measures
        // that below — so the refusal of allowLocalhost costs him nothing, and
        // calling it a loss would raise an alarm about a setting that is in
        // force. The threshold has not moved; the fact underneath it has.
        writeUserSettings("""
                { "allowLocalhost": true }
                """);
        writeWorkspaceSettings(ws, """
                { "permissionMode": "auto", "allowLocalhost": true }
                """);

        SpectroConfig.WorkspaceScopeRefused refused = refusalFrom(projectDir, ws, Map.of());

        assertEquals("allowLocalhost", refused.key());
        assertEquals(Boolean.TRUE, refused.inForce(),
                "the key it named is carried by ~/.spectro at the same value, and it is the"
                        + " only key that goes — so this refusal really does cost nothing");
        assertEquals("user", refused.inForceFrom(),
                "and the layer that carries it can be named, which is a question worth"
                        + " answering now that no unmentioned loss stands beside it");
        assertEquals("auto", SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, ws,
                        Map.of()).permissionMode(),
                "the reason it costs nothing: his permission mode is not lost any more."
                        + " This assertion is the whole of card 369 in one line");
    }

    @Test
    void aFileWhoseEveryKeyIsCarriedAnywayIsFree(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // The other half of the same widening: covering the whole file must not
        // collapse into "a file with more than one key is never free". Both keys
        // are carried at the same value, so dropping this file changes nothing.
        writeUserSettings("""
                { "allowLocalhost": true, "permissionMode": "auto" }
                """);
        writeWorkspaceSettings(ws, """
                { "permissionMode": "auto", "allowLocalhost": true }
                """);

        SpectroConfig.WorkspaceScopeRefused refused = refusalFrom(projectDir, ws, Map.of());

        assertEquals(Boolean.TRUE, refused.inForce(),
                "every key this file sets is in force from the user scope already");
        assertEquals("user", refused.inForceFrom());
    }

    @Test
    void aNeighbourKeyCarriedAtTheOTHERValueIsALossToo(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // The value comparison is the whole difference between a useful answer
        // and a wrong one, and card 369 moved it onto the key that is actually
        // dropped rather than onto the file's neighbours — the neighbours are
        // not dropped any more. The claim is unchanged: a walk asking only "is
        // this key named somewhere allowed" is green here and wrong, because
        // ~/.spectro names allowLocalhost in order to set it the OTHER way.
        writeUserSettings("""
                { "allowLocalhost": false, "permissionMode": "plan" }
                """);
        writeWorkspaceSettings(ws, """
                { "permissionMode": "auto", "allowLocalhost": true }
                """);

        SpectroConfig.WorkspaceScopeRefused refused = refusalFrom(projectDir, ws, Map.of());

        assertEquals(Boolean.FALSE, refused.inForce(),
                "the file asked for allowLocalhost true and true is not what applies");
        assertNull(refused.inForceFrom());
        assertFalse(SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, ws, Map.of())
                        .allowLocalhost(),
                "and the fence really is down: the workspace asked to open it and did not"
                        + " get it, which is the rule this card did not move");
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

        // The only case in this file that needs the FLAGS layer, so it reads the
        // report through the overload that takes one rather than through the
        // helper above. Card 369 moved the refusal from a throw to a value; what
        // this case is about — that the command line counts as a scope that
        // carries the key — is untouched.
        SpectroConfig.WorkspaceScopeRefused refused = SpectroConfig.loadResolved(
                new SpectroConfig.Overrides(null, null, null, null, null, ws.toString()),
                projectDir, ws, Map.of()).report().only();

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
                // ⚠️ A VALID value, and card 369 is what made that necessary.
                //
                // This returned "card-354-<key>" for every string, and for
                // `logLevel` that is not a level the loader accepts. It never
                // showed, because the refusal was THROWN before the fold ever
                // validated anything — the test's fixture was only legal by
                // accident of ordering. With the refusal a value rather than a
                // throw, the fold runs, and an invalid level fails the read for
                // a reason that has nothing to do with what this file asserts.
                //
                // Asked of the loader rather than typed here, so a key that
                // grows a value check tomorrow does not quietly resurrect this.
                return "logLevel".equals(key) ? "debug" : "card-354-" + key;
            }
            throw new AssertionError("no sample value for " + key + " of type " + type);
        }
        throw new AssertionError("\"" + key + "\" is on the workspace-scope refusal list but is not a"
                + " SpectroConfig record component — the refusal probes a field no settings file"
                + " can name, so its cost reading can never be anything but \"not in force\"");
    }

    @Test
    void theCarrierNamedIsTheOneCarryingTheKEYThatWasRefused(
            @TempDir Path projectDir, @TempDir Path ws) throws IOException {
        // Two forbidden keys in one file, carried by two DIFFERENT layers. The
        // refusal names the first key on the list, so the layer it names has to
        // be that key's carrier: a carrier read off the neighbour's probe is
        // green whenever one layer happens to carry both, which every other test
        // in this file arranges by accident.
        writeUserSettings("""
                { "logLevel": "debug" }
                """);
        Map<String, Object> both = new LinkedHashMap<>();
        both.put("logLevel", "debug");
        both.put("allowLocalhost", true);
        writeWorkspaceSettings(ws, JSON.writeValueAsString(both));

        SpectroConfig.WorkspaceScopeRefused refused =
                refusalFrom(projectDir, ws, Map.of("SPECTRO_ALLOW_LOCALHOST", "true"));

        assertEquals("logLevel", refused.key(), "the list is checked in order and logLevel comes first");
        assertEquals(Boolean.TRUE, refused.inForce(),
                "both of this file's keys are carried at the same value, so it costs nothing");
        assertEquals("user", refused.inForceFrom(),
                "logLevel is the refused key and the user scope is what carries it — \"env\""
                        + " would be the answer to the neighbour's question");
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
