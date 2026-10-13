package dev.spectroscope.cli;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Doctor honesty batch (settings-productization final wave): the "layers:"
 * line used to check only the legacy {@code config.json} and print "user
 * config absent" even when {@code settings.json} — the CURRENT user scope —
 * was present, and called the launch-dir file "project settings" rather than
 * naming it as the deprecated compat layer it is. This pins the corrected
 * wording against real files on disk (no env dependency, so it stays
 * deterministic regardless of what the running shell happens to export).
 */
class DoctorCommandTest {

    @AfterEach
    void cleanHome() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    /**
     * Runs doctor with stdout captured. {@code parent} stays unset (a
     * standalone {@code new DoctorCommand()}), so {@code effectiveOverrides()}
     * answers {@code Overrides.none()} and the default anthropic provider
     * check only reads an env var — never a network call — keeping this
     * deterministic in any environment.
     */
    private static String captureDoctorOutput() {
        PrintStream original = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buffer, true, StandardCharsets.UTF_8));
        try {
            new DoctorCommand().call();
        } finally {
            System.setOut(original);
        }
        return buffer.toString(StandardCharsets.UTF_8);
    }

    @Test
    void layersLineNamesTheRealUserScopeWhenOnlySettingsJsonExists() throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, "{}");

        String out = captureDoctorOutput();
        assertTrue(out.contains("user settings.json present"),
                "must name the real user scope, got:\n" + out);
        assertTrue(out.contains("launch-dir settings.json (deprecated)"),
                "must call the launch-dir layer by its real, deprecated name, got:\n" + out);
        assertFalse(out.contains("legacy config.json also present"),
                "no legacy file exists here, so the aside must not appear, got:\n" + out);
    }

    @Test
    void layersLineNamesTheLegacyFileWhenOnlyItExistsAndSettingsJsonIsStillAbsent() throws IOException {
        Files.createDirectories(SpectroConfig.CONFIG_PATH.getParent());
        Files.writeString(SpectroConfig.CONFIG_PATH, "{}");

        String out = captureDoctorOutput();
        assertTrue(out.contains("user settings.json absent"),
                "settings.json itself is still absent — the pre-fix line used to hide this"
                        + " whenever config.json existed, got:\n" + out);
        assertTrue(out.contains("legacy config.json also present"),
                "the legacy file's presence must not be swallowed, got:\n" + out);
    }

    @Test
    void theHubProbeTellsReachableFromUnreachableFromInvalid() throws IOException {
        // The fleet-hub line (node binary wave): a TCP dial, never a wire
        // handshake — doctor informs, it does not join the fleet.
        try (ServerSocket hub = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            String live = DoctorCommand.hubProbe("127.0.0.1:" + hub.getLocalPort());
            assertTrue(live.contains("reachable") && !live.contains("unreachable"),
                    "a listening hub port reports reachable, got: " + live);
        }
        // Port 1 (tcpmux) needs root to bind: nothing listens there on a dev
        // or CI host, and the refusal is instant — no freed-ephemeral-port
        // race with the parallel socket-heavy suites.
        assertTrue(DoctorCommand.hubProbe("127.0.0.1:1").contains("unreachable"),
                "a dead port reports unreachable");
        assertTrue(DoctorCommand.hubProbe("no-port-here").contains("invalid"),
                "a malformed $SPECTRO_HUB names itself invalid instead of dialing");
    }

    @Test
    void theHubHostingLineNamesBothSettingsAndWhatTheServerOpens() {
        // Card 585: SPECTRO_HUB_ENABLED and SPECTRO_HUB_PORT, and what
        // spectro-server makes of them on boot. A port under 1024 is never
        // bound: the line says so and names where the hub goes instead.
        String off = DoctorCommand.hubHostingLine(null, null);
        assertTrue(off.contains("off"), off);
        assertTrue(off.contains("SPECTRO_HUB_ENABLED") && off.contains("SPECTRO_HUB_PORT"), off);

        String written = DoctorCommand.hubHostingLine("true", "7331");
        assertTrue(written.contains("SPECTRO_HUB_ENABLED=true"), written);
        assertTrue(written.contains("SPECTRO_HUB_PORT=7331"), written);
        assertTrue(written.contains("loopback:7331"), written);

        String admin = DoctorCommand.hubHostingLine(null, "1");
        assertTrue(admin.contains("under 1024"), admin);
        assertTrue(admin.contains("7700"), admin);
        assertTrue(!admin.contains("loopback:1 "), "port 1 is never what the server binds: " + admin);

        String typo = DoctorCommand.hubHostingLine("true", "um-what");
        assertTrue(typo.contains("um-what") && typo.contains("7700"), typo);

        String switchedOff = DoctorCommand.hubHostingLine("false", "7331");
        assertTrue(switchedOff.contains("off"), switchedOff);

        for (String line : new String[] {off, written, admin, typo, switchedOff}) {
            assertTrue(!line.contains("\u2014") && !line.contains("\u2013"), "no dashes: " + line);
        }
    }

    @Test
    void theHubSettingsAreReadTheWayTheServerReadsThem() throws IOException {
        // Review N2: the server takes the LAST line and keeps quotes, and a
        // variable in the environment wins even when it is blank. The doctor
        // used to take the first line and strip the quotes, so it promised
        // loopback:7745 for SPECTRO_HUB_PORT="7745" while the server walked.
        java.nio.file.Path file = Files.createTempFile("doctor-585-", ".env");
        try {
            Files.writeString(file, "SPECTRO_HUB_PORT=1\nSPECTRO_HUB_PORT=\"7745\"\nSPECTRO_HUB_ENABLED=true\n");
            java.util.Map<String, String> read = DoctorCommand.hubSettingsFrom(java.util.Map.of(), file);
            assertEquals("\"7745\"", read.get("SPECTRO_HUB_PORT"));
            assertEquals("true", read.get("SPECTRO_HUB_ENABLED"));
            String line = DoctorCommand.hubHostingLine(read.get("SPECTRO_HUB_ENABLED"), read.get("SPECTRO_HUB_PORT"));
            assertTrue(line.contains("not a port number"), line);

            java.util.Map<String, String> fromEnv = DoctorCommand.hubSettingsFrom(
                    java.util.Map.of("SPECTRO_HUB_PORT", "7746", "SPECTRO_HUB_ENABLED", ""), file);
            assertEquals("7746", fromEnv.get("SPECTRO_HUB_PORT"), "the environment wins");
            assertEquals("", fromEnv.get("SPECTRO_HUB_ENABLED"), "a blank variable wins too, as in the server");
        } finally {
            Files.deleteIfExists(file);
        }
    }

    @Test
    void anAppRangePortIsNamedInTheHostingLine() {
        String line = DoctorCommand.hubHostingLine("true", "8080");
        assertTrue(line.contains("8080") && line.contains("7700"), line);
        assertTrue(!line.contains("loopback:8080"), line);
    }
}
