package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The persist path for a web "always allow · dauerhaft" click: read-modify-write the shared allowlist. */
class SettingsWriterTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void appendsARuleAndPreservesUnknownKeys(@TempDir Path projectDir) throws IOException {
        Path file = projectDir.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(file.getParent());
        Files.writeString(file, """
                { "mcpServers": { "notes": { "command": "java", "args": ["-jar", "n.jar"] } } }
                """);

        SettingsWriter.appendAutoApprove(projectDir, "run_command:git*");

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertTrue(config.autoApprove().contains("run_command:git*"),
                "the persisted rule reaches the CLI's allowlist on the next load");
        assertEquals(1, config.mcpServers().size(), "a pre-existing block must survive the write");
        assertEquals("notes", config.mcpServers().get(0).name());
    }

    @Test
    void doesNotDuplicateAnExistingRule(@TempDir Path projectDir) throws IOException {
        SettingsWriter.appendAutoApprove(projectDir, "write_file");
        SettingsWriter.appendAutoApprove(projectDir, "write_file");
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals(1, config.autoApprove().stream().filter("write_file"::equals).count());
    }

    @Test
    void createsTheSettingsFileWhenAbsent(@TempDir Path projectDir) throws IOException {
        SettingsWriter.appendAutoApprove(projectDir, "write_file");
        assertTrue(Files.exists(projectDir.resolve(SpectroConfig.PROJECT_SETTINGS)));
    }

    @Test
    void patchWritesMergesAndRemoves(@TempDir Path dir) throws IOException {
        Path file = dir.resolve(".spectro/settings.json");
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.readTree("""
                        { "provider": "ollama", "model": "qwen3" }
                        """));
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.readTree("""
                        { "model": null, "thinking": false }
                        """));
        JsonNode root = JSON.readTree(Files.readString(file));
        assertEquals("ollama", root.path("provider").asText());
        assertFalse(root.has("model"), "null removes the key");
        assertFalse(root.path("thinking").asBoolean());
    }

    @Test
    void patchPreservesForeignKeys(@TempDir Path dir) throws IOException {
        Path file = dir.resolve(".spectro/settings.json");
        Files.createDirectories(file.getParent());
        Files.writeString(file, """
                { "tts": { "enabled": true }, "provider": "anthropic" }
                """);
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.readTree("""
                        { "provider": "ollama" }
                        """));
        JsonNode root = JSON.readTree(Files.readString(file));
        assertTrue(root.path("tts").path("enabled").asBoolean(), "foreign blocks survive");
        assertEquals("ollama", root.path("provider").asText());
    }

    @Test
    void patchRejectsSecretsUnknownsAndBadValues(@TempDir Path dir) {
        Path file = dir.resolve(".spectro/settings.json");
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.USER, JSON.readTree("""
                        { "ANTHROPIC_API_KEY": "sk-nope" }
                        """)), "secret-shaped keys are refused");
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.USER, JSON.readTree("""
                        { "providr": "ollama" }
                        """)), "unknown keys are refused loudly");
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.USER, JSON.readTree("""
                        { "logLevel": "verbose" }
                        """)), "bad values are refused before the write");
        assertFalse(Files.exists(file), "nothing was written on any rejection");
    }

    @Test
    void workspaceScopesRejectProcessGlobals(@TempDir Path dir) {
        Path file = dir.resolve(".spectro/settings.json");
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.PROJECT, JSON.readTree("""
                        { "workspace": "/elsewhere" }
                        """)));
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.LOCAL, JSON.readTree("""
                        { "logLevel": "debug" }
                        """)));
    }

    @Test
    void aLocalWriteDropsTheGitignore(@TempDir Path dir) throws IOException {
        Path file = dir.resolve(".spectro/settings.local.json");
        SettingsWriter.patch(file, SettingsWriter.Scope.LOCAL,
                JSON.readTree("""
                        { "provider": "ollama" }
                        """));
        String gitignore = Files.readString(dir.resolve(".spectro/.gitignore"));
        assertTrue(gitignore.contains("settings.local.json"));
        // Idempotent: a second write must not duplicate the line.
        SettingsWriter.patch(file, SettingsWriter.Scope.LOCAL,
                JSON.readTree("""
                        { "model": "qwen3" }
                        """));
        long count = Files.readString(dir.resolve(".spectro/.gitignore")).lines()
                .filter(l -> l.equals("settings.local.json")).count();
        assertEquals(1, count);
    }
}
