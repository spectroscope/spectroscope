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
    void theSearxngAddressIsAWritableKeyAndRemovableAgain(@TempDir Path dir) throws IOException {
        // Card 203, review finding F2: the Settings page saves the instance address
        // through PUT /api/settings, which lands in patch() and dies on the
        // KNOWN_KEYS check. Nothing held that string, so dropping "searxngUrl" from
        // the allowlist would have made the one working configuration path answer
        // "unknown key" — with the whole suite green.
        Path file = dir.resolve(".spectro/settings.json");
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.readTree("""
                        { "searxngUrl": "http://box.local:8888" }
                        """));
        assertEquals("http://box.local:8888",
                JSON.readTree(Files.readString(file)).path("searxngUrl").asText());

        // And the page's reset arrow, which sends null.
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.readTree("""
                        { "searxngUrl": null }
                        """));
        assertFalse(JSON.readTree(Files.readString(file)).has("searxngUrl"),
                "null removes the key, so the tier falls back to whatever is configured below");
    }

    @Test
    void sttLanguageWritesLikeSttProviderAndRefusesUnknownCodes(@TempDir Path dir)
            throws IOException {
        Path file = dir.resolve(".spectro/settings.json");
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.readTree("""
                        { "sttLanguage": "de" }
                        """));
        assertEquals("de", JSON.readTree(Files.readString(file)).path("sttLanguage").asText());

        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.USER, JSON.readTree("""
                        { "sttLanguage": "klingon" }
                        """)), "only auto, de and en are known dictation languages");
    }

    @Test
    void perProviderAddressesAreWritableSettingsKeys(@TempDir Path dir) throws IOException {
        // Card 193: the settings page's address field writes these through the
        // settings API — the writer must know both keys, and null must clear.
        Path file = dir.resolve(".spectro/settings.json");
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.readTree("""
                        { "ollamaBaseUrl": "http://gpu-box:11434",
                          "lmstudioBaseUrl": "http://gpu-box:1234" }
                        """));
        JsonNode root = JSON.readTree(Files.readString(file));
        assertEquals("http://gpu-box:11434", root.path("ollamaBaseUrl").asText());
        assertEquals("http://gpu-box:1234", root.path("lmstudioBaseUrl").asText());

        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.readTree("""
                        { "ollamaBaseUrl": null }
                        """));
        assertFalse(JSON.readTree(Files.readString(file)).has("ollamaBaseUrl"),
                "null clears the per-provider address");
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
        // Card 199, review finding F4: the net fence's opt-in is a machine-wide
        // decision, and a workspace scope is a folder the agent writes into.
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.PROJECT, JSON.readTree("""
                        { "allowLocalhost": true }
                        """)));
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.patch(file,
                SettingsWriter.Scope.LOCAL, JSON.readTree("""
                        { "allowLocalhost": true }
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

    @Test
    void settingsFileIsOwnerReadableOnly(@TempDir Path dir) throws IOException {
        // A settings file is not a good place for a credential, and one lands there
        // anyway: otlpBasicAuth is a writable key, so the Settings UI's Observability
        // field puts a Langfuse pk:sk into this document. Owner-only is the floor.
        // The file is created fresh here AND overwritten below, because a mode that
        // only holds for the create path is not a guarantee.
        Path file = dir.resolve(".spectro/settings.json");
        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.readTree("{ \"otlpBasicAuth\": \"pk-lf-x:sk-lf-y\" }"));
        assertOwnerOnly(file);

        SettingsWriter.patch(file, SettingsWriter.Scope.USER,
                JSON.readTree("{ \"provider\": \"ollama\" }"));
        assertOwnerOnly(file);
    }

    private static void assertOwnerOnly(Path file) throws IOException {
        if (!file.getFileSystem().supportedFileAttributeViews().contains("posix")) {
            return;   // no POSIX modes to assert (Windows); the write itself is checked above
        }
        java.util.Set<java.nio.file.attribute.PosixFilePermission> perms =
                Files.getPosixFilePermissions(file);
        assertEquals(java.util.Set.of(
                        java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                        java.nio.file.attribute.PosixFilePermission.OWNER_WRITE),
                perms,
                "settings.json carries a credential; group and world must not read it");
    }
}
