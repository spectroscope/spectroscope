package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 220: the settings half of the owner's combined road. {@code headlessMcp}
 * is the settings-level opt-in every headless face honours — {@code spectro run},
 * a cron fire and a triggered fleet node all read it off the same config, and
 * a manual {@code spectro run} may override it per invocation with
 * {@code --mcp} / {@code --no-mcp} (that half lives on the runner, not here).
 *
 * <p>Default OFF, additive: a settings file written before this field existed
 * resolves exactly as it did, and the headless belt stays the nine standard
 * tools until an operator opts in — the constraint order on the card puts
 * permission above capability.
 */
class HeadlessMcpConfigTest {

    @Test
    void headlessMcpDefaultsToFalse(@TempDir Path projectDir) {
        SpectroConfig config = SpectroConfig.load(
                SpectroConfig.Overrides.none(), projectDir, Map.of());
        assertFalse(config.headlessMcp(),
                "an unattended run must not grow reach nobody chose — the opt-in is OFF"
                        + " until a settings layer says otherwise");
    }

    @Test
    void aSettingsFileTurnsHeadlessMcpOn(@TempDir Path projectDir) throws IOException {
        Files.createDirectories(projectDir.resolve(".spectro"));
        Files.writeString(projectDir.resolve(".spectro/settings.json"), """
                { "headlessMcp": true }
                """);
        SpectroConfig config = SpectroConfig.load(
                SpectroConfig.Overrides.none(), projectDir, Map.of());
        assertTrue(config.headlessMcp(),
                "the settings-level opt-in is the owner's 'wenn man mit der UI arbeitet'"
                        + " half — a declared consent the headless faces honour");
    }

    @Test
    void theEnvironmentFormIsSpectroHeadlessMcp(@TempDir Path projectDir) {
        SpectroConfig on = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir,
                Map.of("SPECTRO_HEADLESS_MCP", "true"));
        assertTrue(on.headlessMcp(), "SPECTRO_HEADLESS_MCP=true is the env layer's spelling");

        // The same 1/0/true/false rule as SPECTRO_THINKING: anything else is false.
        SpectroConfig off = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir,
                Map.of("SPECTRO_HEADLESS_MCP", "yes-please"));
        assertFalse(off.headlessMcp(), "only 1/true count as true, like every other bool env");
    }

    @Test
    void aSettingsFileOutranksTheEnvironment(@TempDir Path projectDir) throws IOException {
        Files.createDirectories(projectDir.resolve(".spectro"));
        Files.writeString(projectDir.resolve(".spectro/settings.json"), """
                { "headlessMcp": false }
                """);
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir,
                Map.of("SPECTRO_HEADLESS_MCP", "1"));
        assertFalse(config.headlessMcp(),
                "env is the BASE layer — a settings file saying no wins over an env saying yes");
    }

    @Test
    void aWorkspaceScopeMayNotFlipTheSwitch(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // The same reasoning that fenced allowLocalhost (card 199 F4): the
        // workspace is the folder the agent itself writes into, and headlessMcp
        // is the switch that widens what an UNATTENDED run may reach. A consent
        // switch living inside the sandbox it guards could be flipped by one
        // auto-approved write_file — the next cron fire in that workspace would
        // then mount every configured server with nobody watching.
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "headlessMcp": true }
                """);
                // Card 369: the RULE, on the outcome. The throw is gone — a forbidden
        // key is dropped and the file's legal keys apply — and the rule it
        // enforced has not moved: this key still never reaches a run.
        var report = SpectroConfig.reportFor(projectDir, ws, java.util.Map.of());
        assertTrue(report.dropped().contains("headlessMcp"),
                "the refusal must name the key, got: " + report.dropped());
        assertTrue(report.only().getMessage() != null
                && report.only().getMessage().contains("workspace scope"),
                "the refusal must name the rule it breaks: " + report.only().getMessage());
    }

    @Test
    void provenanceKnowsTheField(@TempDir Path projectDir) throws IOException {
        // The /api/config origins view is driven off FIELD_PROBES — a field
        // missing there resolves fine and lies about where it came from.
        Files.createDirectories(projectDir.resolve(".spectro"));
        Files.writeString(projectDir.resolve(".spectro/settings.json"), """
                { "headlessMcp": true }
                """);
        SpectroConfig.Resolved resolved = SpectroConfig.loadResolved(
                SpectroConfig.Overrides.none(), projectDir, null);
        SpectroConfig.Origin origin = resolved.origins().get("headlessMcp");
        assertTrue(origin != null, "headlessMcp needs a FieldProbe or /api/config never"
                + " says which layer set it");
        assertEquals("launch-dir", origin.winner(),
                "the launch-dir settings file set it, so that layer won");
    }

    @Test
    void theSettingsApiAcceptsTheKeyInTheUserScope(@TempDir Path home) throws IOException {
        // The settings page's toggle saves through SettingsWriter.patch — an
        // unknown key is refused before the file is touched, so without this
        // entry the UI half of the owner's decision cannot exist.
        Path file = home.resolve("settings.json");
        Files.writeString(file, "{}\n");
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                new com.fasterxml.jackson.databind.ObjectMapper()
                        .createObjectNode().put("headlessMcp", true));
        assertTrue(Files.readString(file).contains("\"headlessMcp\" : true"),
                "the patched user settings file carries the switch");
    }
}
