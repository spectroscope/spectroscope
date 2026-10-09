package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.ToolGroup;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 466, criteria 1 and 5 at the settings layer: {@code toolGroupsOff} is
 * accepted at user, project and local scope, an unknown group name is refused
 * on write (the settings API answers that with 400) and on load, and the
 * shipped value is the empty list, which sends every tool.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class ToolGroupsOffSettingTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void theShippedValueSwitchesNothingOff() {
        assertEquals(List.of(), SpectroConfig.shippedDefaults().toolGroupsOff());
        assertTrue(SpectroConfig.shippedDefaults().toolGroupsOffSet().isEmpty());
    }

    @Test
    void everyScopeAcceptsAKnownGroupList(@TempDir Path dir) throws Exception {
        for (SettingsWriter.Scope scope : SettingsWriter.Scope.values()) {
            Path file = dir.resolve(scope.name().toLowerCase() + ".json");
            SettingsWriter.patch(file, scope, JSON.readTree("""
                    { "toolGroupsOff": ["browser", "launch"] }"""));
            assertEquals(List.of("browser", "launch"),
                    List.of(JSON.readTree(Files.readString(file)).get("toolGroupsOff").get(0).asText(),
                            JSON.readTree(Files.readString(file)).get("toolGroupsOff").get(1).asText()),
                    scope + " holds what was written");
        }
    }

    @Test
    void anUnknownGroupIsRefusedOnWriteInEveryScopeAndNothingIsWritten(@TempDir Path dir)
            throws Exception {
        for (SettingsWriter.Scope scope : SettingsWriter.Scope.values()) {
            Path file = dir.resolve(scope.name().toLowerCase() + ".json");
            IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                    () -> SettingsWriter.patch(file, scope, JSON.readTree("""
                            { "toolGroupsOff": ["browser", "printer"] }""")), scope.name());
            assertTrue(refused.getMessage().contains("printer"), refused.getMessage());
            assertTrue(refused.getMessage().contains("launch"),
                    "the message lists the known groups: " + refused.getMessage());
            assertFalse(Files.exists(file), scope + ": nothing written");
        }
    }

    @Test
    void aNullEntryIsRefusedOnWriteRatherThanThrowingSomethingElse(@TempDir Path dir) {
        Path file = dir.resolve("local.json");
        assertThrows(IllegalArgumentException.class,
                () -> SettingsWriter.patch(file, SettingsWriter.Scope.LOCAL, JSON.readTree("""
                        { "toolGroupsOff": [null] }""")));
    }

    @Test
    void anUnknownGroupInAFileIsRefusedOnLoad(@TempDir Path ws) throws Exception {
        Path settings = ws.resolve(SpectroConfig.WS_LOCAL_SETTINGS);
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, "{\"toolGroupsOff\": [\"printer\"]}");

        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(),
                        ws.resolve("nowhere"), ws));
        assertTrue(refused.getMessage().contains("toolGroupsOff"), refused.getMessage());
        assertTrue(refused.getMessage().contains("printer"), refused.getMessage());
    }

    @Test
    void aLocalListBeatsTheProjectListAndArrivesAsGroups(@TempDir Path ws) throws Exception {
        Path project = ws.resolve(SpectroConfig.PROJECT_SETTINGS);
        Path local = ws.resolve(SpectroConfig.WS_LOCAL_SETTINGS);
        Files.createDirectories(project.getParent());
        Files.writeString(project, "{\"toolGroupsOff\": [\"mcp\"]}");
        Files.writeString(local, "{\"toolGroupsOff\": [\"browser\", \"launch\"]}");

        SpectroConfig loaded = SpectroConfig.loadForWorkspace(
                SpectroConfig.Overrides.none(), ws.resolve("nowhere"), ws);

        assertEquals(List.of("browser", "launch"), loaded.toolGroupsOff());
        assertEquals(EnumSet.of(ToolGroup.BROWSER, ToolGroup.LAUNCH), loaded.toolGroupsOffSet());
    }

    @Test
    void theKeyIsWritableThroughTheSettingsApi() {
        assertTrue(SettingsWriter.knownKeys().contains("toolGroupsOff"));
    }

    /**
     * The config reference must not promise the list to a face that never
     * reads it. Every main source file that builds an agent without wiring
     * the switch is found here from the tree, and the toolGroupsOff row must
     * name its face. A new face that builds an agent without the switch goes
     * red until it is wired or named.
     */
    @Test
    void theConfigReferenceNamesEveryFaceThatBuildsAnAgentWithoutTheList() throws IOException {
        Path root = repoRoot();
        assertNotNull(root, "repo root with settings.gradle.kts");
        Map<String, String> faceWords = Map.of(
                "SpectroCli.java", "REPL",
                "HeadlessRunner.java", "<code>spectro run</code>",
                "Spectro.java", "<code>Spectro.agent()</code>",
                "OrchestratorPanel.java", "<code>Spectro.panel()</code>");
        List<String> blind = new ArrayList<>();
        try (Stream<Path> modules = Files.list(root)) {
            for (Path main : modules.map(module -> module.resolve("src/main/java"))
                    .filter(Files::isDirectory).toList()) {
                try (Stream<Path> files = Files.walk(main)) {
                    for (Path file : files.filter(f -> f.toString().endsWith(".java")).toList()) {
                        String source = Files.readString(file);
                        String name = file.getFileName().toString();
                        if (!name.equals("AgentOptions.java")
                                && source.contains("AgentOptions.builder()")
                                && !source.contains(".toolGroupsOff(")) {
                            blind.add(name);
                        }
                    }
                }
            }
        }
        assertFalse(blind.isEmpty(), "test premise: some face builds an agent without the switch");
        String reference = Files.readString(
                root.resolve("docs/guide-assets/parts/18-ref-config-build.html"));
        String row = reference.lines()
                .filter(line -> line.contains("<td><code>toolGroupsOff</code></td>"))
                .findFirst().orElse("");
        assertFalse(row.isEmpty(), "the reference has a toolGroupsOff row");
        for (String name : blind) {
            String words = faceWords.get(name);
            assertNotNull(words, name + " builds an agent without toolGroupsOff: wire the switch"
                    + " there or name its face in the toolGroupsOff row and here");
            assertTrue(row.contains(words), "the toolGroupsOff row names the face of " + name
                    + " (" + words + ") as one that does not read the list");
        }
    }

    /** Walks up to the directory holding the Gradle settings file. */
    private static Path repoRoot() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
