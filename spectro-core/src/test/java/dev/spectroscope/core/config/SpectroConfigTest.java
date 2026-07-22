package dev.spectroscope.core.config;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The full settings hierarchy: defaults &lt; env (SPECTRO_*) &lt;
 * ~/.spectro/settings.json (config.json compat) &lt;
 * &lt;project&gt;/.spectro/settings.json &lt; CLI flags — plus the local-model
 * fallbacks and the allowlist field. The Gradle test task redirects
 * {@code user.home} into the build directory.
 */
class SpectroConfigTest {

    @AfterEach
    void removeUserConfig() throws IOException {
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
    }

    private static void writeUserConfig(String json) throws IOException {
        Files.createDirectories(SpectroConfig.CONFIG_PATH.getParent());
        Files.writeString(SpectroConfig.CONFIG_PATH, json);
    }

    private static void writeUserSettings(String json) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, json);
    }

    private static void writeProjectSettings(Path projectDir, String json) throws IOException {
        Path file = projectDir.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
    }

    @Test
    void defaultsApplyWithoutAnyFile(@TempDir Path projectDir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals("anthropic", config.provider());
        assertEquals("claude-opus-4-8", config.model());
        assertEquals(100_000, config.compactionThreshold());
        assertEquals("ask", config.permissionMode());
        assertEquals(List.of(), config.autoApprove());
    }

    @Test
    void projectSettingsOverrideTheUserConfig(@TempDir Path projectDir) throws IOException {
        writeUserConfig("""
                { "provider": "ollama", "model": "llama3.1", "compactionThreshold": 5000 }
                """);
        writeProjectSettings(projectDir, """
                { "model": "qwen3", "autoApprove": ["run_command:git status*"] }
                """);

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals("ollama", config.provider(), "provider from the user layer survives");
        assertEquals("qwen3", config.model(), "model from the project layer wins");
        assertEquals(5000, config.compactionThreshold(), "threshold from the user layer survives");
        assertEquals(List.of("run_command:git status*"), config.autoApprove());
    }

    @Test
    void aTtsBlockInTheConfigDoesNotBreakLoading(@TempDir Path projectDir) throws IOException {
        // the voice-output tts block is read CLI-side (dev.spectroscope.cli.speech.TtsConfig),
        // but it lives in the SAME ~/.spectro/config.json. The core must ignore it, not drop
        // the whole layer — the provider/model still come through unharmed.
        writeUserConfig("""
                { "provider": "anthropic", "model": "claude-opus-4-8",
                  "tts": { "enabled": true, "voice": "en_US-lessac-medium" } }
                """);

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals("anthropic", config.provider(), "the tts block must not drop the config layer");
        assertEquals("claude-opus-4-8", config.model());
    }

    @Test
    void aMalformedSettingsFileFailsLoudlyNamingTheFile(@TempDir Path projectDir) throws IOException {
        // Final wave (fix 3): readFile used to catch IOException wholesale, so
        // broken JSON silently loaded as an EMPTY layer — contradicting both this
        // class's own javadoc ("malformed JSON fails loudly on purpose") and the
        // USER-GUIDE. Only genuine file-absence may fall back to empty; a parse
        // failure must name the file and the problem.
        writeProjectSettings(projectDir, "{ not valid json ");
        Path file = projectDir.resolve(SpectroConfig.PROJECT_SETTINGS);

        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir));
        assertTrue(failure.getMessage().contains(file.toString()),
                "names the broken file, got: " + failure.getMessage());
    }

    @Test
    void aMissingSettingsFileStillLoadsAsAnAbsentLayer(@TempDir Path projectDir) {
        // The other half of fix 3: a file that simply does not exist (no
        // .spectro directory at all) must still be a perfectly normal absent
        // layer, never an exception.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals("anthropic", config.provider());
    }

    @Test
    void flagsOverrideEveryFileLayer(@TempDir Path projectDir) throws IOException {
        writeUserConfig("""
                { "provider": "ollama" }
                """);
        writeProjectSettings(projectDir, """
                { "provider": "openai" }
                """);
        SpectroConfig config = SpectroConfig.load(
                new SpectroConfig.Overrides("anthropic", "claude-opus-4-8", null, null, null, null),
                projectDir);
        assertEquals("anthropic", config.provider());
        assertEquals("claude-opus-4-8", config.model());
    }

    @Test
    void localProvidersFallBackToLocalModels(@TempDir Path projectDir) {
        assertEquals("qwen3", SpectroConfig.load(
                new SpectroConfig.Overrides("ollama", null, null, null, null, null), projectDir).model());
        assertEquals("local-model", SpectroConfig.load(
                new SpectroConfig.Overrides("openai", null, null, null, null, null), projectDir).model());
    }

    @Test
    void environmentSitsBelowTheSettingsFiles(@TempDir Path projectDir)
            throws IOException {
        writeProjectSettings(projectDir, """
                { "provider": "anthropic" }
                """);
        var env = java.util.Map.of("SPECTRO_PROVIDER", "ollama", "SPECTRO_MODEL", "llama3.1");

        // flipped 2026-07-18: settings call the shots, env is the base
        SpectroConfig fromEnv = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env);
        assertEquals("anthropic", fromEnv.provider(), "the project settings file beats the environment");
        assertEquals("llama3.1", fromEnv.model(), "env still fills what the file does not state");

        SpectroConfig flagged = SpectroConfig.load(
                new SpectroConfig.Overrides("openai", null, null, null, null, null), projectDir, env);
        assertEquals("openai", flagged.provider(), "flags beat everything");
    }

    @Test
    void workspaceFollowsThePrecedenceChain(@TempDir Path projectDir) throws IOException {
        assertEquals(null, SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir).workspace(),
                "unset means the per-session temp folder");

        writeProjectSettings(projectDir, """
                { "workspace": "/tmp/from-settings" }
                """);
        assertEquals("/tmp/from-settings",
                SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir).workspace());

        var env = java.util.Map.of("SPECTRO_WORKSPACE", "/tmp/from-env");
        // flipped 2026-07-18: settings call the shots, env is the base
        assertEquals("/tmp/from-settings",
                SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env).workspace(),
                "the project settings file beats the environment");

        SpectroConfig flagged = SpectroConfig.load(new SpectroConfig.Overrides(
                null, null, null, null, null, "/tmp/from-flag"), projectDir, env);
        assertEquals("/tmp/from-flag", flagged.workspace(), "the flag beats the environment");
    }

    @Test
    void unknownProvidersFailLoudly(@TempDir Path projectDir) {
        assertThrows(IllegalArgumentException.class, () -> SpectroConfig.load(
                new SpectroConfig.Overrides("not-a-real-provider", null, null, null, null, null), projectDir));
    }

    @Test
    void imageProviderDefaultsToGeminiAndReadsTheEnvironmentLayer(@TempDir Path projectDir)
            throws IOException {
        assertEquals("gemini",
                SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir).imageProvider());

        writeProjectSettings(projectDir, """
                { "imageProvider": "openai" }
                """);
        assertEquals("openai",
                SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir).imageProvider(),
                "the project settings layer sets the image backend");

        var env = java.util.Map.of("SPECTRO_IMAGE_PROVIDER", "gemini");
        // flipped 2026-07-18: settings call the shots, env is the base
        assertEquals("openai",
                SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env).imageProvider(),
                "the project settings layer beats the environment");
    }

    @Test
    void unknownImageProvidersFailLoudly(@TempDir Path projectDir) {
        var env = java.util.Map.of("SPECTRO_IMAGE_PROVIDER", "dall-e");
        assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env));
    }

    @Test
    void aMistypedPermissionModeFailsLoudlyNeverSilently(@TempDir Path projectDir) throws IOException {
        // Final wave (fix 2): permissionMode used to load without any validation
        // at all — a typo in a settings file would silently become the effective
        // mode instead of failing like provider/imageProvider/logLevel already do.
        writeProjectSettings(projectDir, """
                { "permissionMode": "readonli" }
                """);
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir));
        assertTrue(failure.getMessage().contains("readonli"),
                "names the bad value, got: " + failure.getMessage());
        assertTrue(failure.getMessage().contains("auto"),
                "names the allowed set, got: " + failure.getMessage());
    }

    @Test
    void thinkingDefaultsToTrueAndRespectsEnvironmentAndProjectSettings(@TempDir Path projectDir)
            throws IOException {
        assertTrue(SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir).thinking(),
                "thinking defaults on");

        var envOff = java.util.Map.of("SPECTRO_THINKING", "0");
        assertFalse(SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, envOff).thinking(),
                "SPECTRO_THINKING=0 turns it off");

        var envTrue = java.util.Map.of("SPECTRO_THINKING", "true");
        assertTrue(SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, envTrue).thinking(),
                "SPECTRO_THINKING=true turns it on");

        writeProjectSettings(projectDir, """
                { "thinking": false }
                """);
        assertFalse(SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir).thinking(),
                "the project settings layer can disable thinking");

        // flipped 2026-07-18: settings call the shots, env is the base
        var envNoLongerBeatsProject = java.util.Map.of("SPECTRO_THINKING", "1");
        assertFalse(SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, envNoLongerBeatsProject)
                        .thinking(),
                "the project settings layer beats the environment");
    }

    @Test
    void mcpServersDefaultToAnEmptyListNeverNull(@TempDir Path projectDir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        org.junit.jupiter.api.Assertions.assertNotNull(config.mcpServers());
        assertTrue(config.mcpServers().isEmpty(), "no mcpServers configured → empty list");
    }

    @Test
    void mcpServersParseFromTheObjectKeyedByName(@TempDir Path projectDir) throws IOException {
        writeUserConfig("""
                {
                  "mcpServers": {
                    "notes": {
                      "command": "java",
                      "args": ["-jar", "/path/to/spectro-mcp-notes.jar", "~/.spectro/notes"]
                    }
                  }
                }
                """);
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals(1, config.mcpServers().size());
        var notes = config.mcpServers().get(0);
        assertEquals("notes", notes.name(), "name comes from the object key");
        assertEquals("java", notes.command());
        assertEquals(List.of("-jar", "/path/to/spectro-mcp-notes.jar", "~/.spectro/notes"),
                notes.args());
        assertEquals(dev.spectroscope.core.mcp.McpServerConfig.TransportKind.STDIO, notes.transportKind());
    }

    @Test
    void projectSettingsReplaceTheUserMcpServerBlockWholesale(@TempDir Path projectDir)
            throws IOException {
        // user layer defines one server ...
        writeUserConfig("""
                { "mcpServers": { "notes": { "command": "java", "args": ["-jar", "user.jar"] } } }
                """);
        // ... the project layer defines a DIFFERENT one — whole-block replacement.
        writeProjectSettings(projectDir, """
                { "mcpServers": { "remote": { "url": "http://localhost:8931/sse", "type": "sse" } } }
                """);

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals(1, config.mcpServers().size(), "project block replaces the user block");
        var only = config.mcpServers().get(0);
        assertEquals("remote", only.name());
        assertEquals("http://localhost:8931/sse", only.url());
        assertEquals(dev.spectroscope.core.mcp.McpServerConfig.TransportKind.HTTP_SSE, only.transportKind());
    }

    @Test
    void absentProjectSettingsLeaveTheUserMcpServerBlockStanding(@TempDir Path projectDir)
            throws IOException {
        writeUserConfig("""
                { "mcpServers": { "notes": { "command": "java", "args": ["-jar", "user.jar"] } } }
                """);
        // projectDir has no .spectro/settings.json → the user layer stands.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals(1, config.mcpServers().size());
        assertEquals("notes", config.mcpServers().get(0).name());
    }

    @Test
    void projectMdIsWrappedIntoASystemPromptSection(@TempDir Path cwd) throws IOException {
        assertEquals("", SpectroConfig.loadProjectMd(cwd), "absent file → empty string");
        Files.writeString(cwd.resolve("SPECTRO.md"), "Always answer in Bavarian German.");
        String section = SpectroConfig.loadProjectMd(cwd);
        assertTrue(section.contains("## Project context (SPECTRO.md)"));
        assertTrue(section.contains("Bavarian"));
    }

    @Test
    void legacyForgeMdStillLoadsButSpectroMdWins(@TempDir Path cwd) throws IOException {
        // Pre-rename workspaces keep working: the legacy name is read …
        Files.writeString(cwd.resolve("FORGE.md"), "legacy rules");
        assertTrue(SpectroConfig.loadProjectMd(cwd).contains("## Project context (FORGE.md)"));
        // … and the new name takes over the moment it exists.
        Files.writeString(cwd.resolve("SPECTRO.md"), "current rules");
        String section = SpectroConfig.loadProjectMd(cwd);
        assertTrue(section.contains("## Project context (SPECTRO.md)"));
        assertTrue(section.contains("current rules"));
    }

    @Test
    void hooksDefaultToAnEmptyListNeverNull(@TempDir Path projectDir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        org.junit.jupiter.api.Assertions.assertNotNull(config.hooks());
        assertTrue(config.hooks().isEmpty(), "no hooks configured → empty list");
    }

    @Test
    void hooksParseFromAnArrayOfEntries(@TempDir Path projectDir) throws IOException {
        writeUserConfig("""
                {
                  "hooks": [
                    { "event": "pre_tool_use", "matcher": "run_command", "command": "./scripts/guard.sh" }
                  ]
                }
                """);
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals(1, config.hooks().size());
        HookConfig hook = config.hooks().get(0);
        assertEquals("pre_tool_use", hook.event());
        assertEquals("run_command", hook.matcher());
        assertEquals("./scripts/guard.sh", hook.command());
    }

    @Test
    void projectSettingsReplaceTheUserHooksBlockWholesale(@TempDir Path projectDir)
            throws IOException {
        // user layer defines one hook ...
        writeUserConfig("""
                { "hooks": [ { "event": "pre_tool_use", "matcher": "*", "command": "echo user" } ] }
                """);
        // ... the project layer defines a DIFFERENT one — whole-block replacement.
        writeProjectSettings(projectDir, """
                { "hooks": [ { "event": "pre_tool_use", "matcher": "run_command", "command": "echo project" } ] }
                """);

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals(1, config.hooks().size(), "project block replaces the user block");
        assertEquals("run_command", config.hooks().get(0).matcher());
        assertEquals("echo project", config.hooks().get(0).command());
    }

    @Test
    void retryAndCachingDefaultsAreOnWithTwoRetries(@TempDir Path projectDir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals(2, config.maxRetries(), "default retry count is 2");
        assertTrue(config.promptCaching(), "prompt caching defaults on");
    }

    @Test
    void environmentOverridesRetryAndCaching(@TempDir Path projectDir) {
        var env = java.util.Map.of("SPECTRO_MAX_RETRIES", "5", "SPECTRO_PROMPT_CACHING", "0");
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env);
        assertEquals(5, config.maxRetries());
        assertFalse(config.promptCaching());
    }

    @Test
    void aMalformedMaxRetriesEnvFailsLoudlyAndReadably(@TempDir Path projectDir) {
        var env = java.util.Map.of("SPECTRO_MAX_RETRIES", "abc");
        IllegalArgumentException error = assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env));
        assertTrue(error.getMessage().contains("SPECTRO_MAX_RETRIES"),
                "the message must name the variable, got: " + error.getMessage());
    }

    @Test
    void projectSettingsCanSetRetryAndCaching(@TempDir Path projectDir) throws IOException {
        writeProjectSettings(projectDir, """
                { "provider": "ollama", "maxRetries": 4, "promptCaching": false }
                """);
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals(4, config.maxRetries());
        assertFalse(config.promptCaching());
    }

    @Test
    void providerFromConfigWrapsWithRetryUnlessDisabled(@TempDir Path projectDir) {
        // Ollama needs no key, so we can construct the provider here.
        var wrapped = SpectroConfig.load(
                new SpectroConfig.Overrides("ollama", null, null, null, null, null), projectDir)
                .providerFromConfig();
        assertTrue(wrapped instanceof dev.spectroscope.core.provider.RetryingProvider,
                "retries on by default: the provider is retry-wrapped");

        var raw = SpectroConfig.load(
                new SpectroConfig.Overrides("ollama", null, null, null, null, null), projectDir,
                java.util.Map.of("SPECTRO_MAX_RETRIES", "0"))
                .providerFromConfig();
        assertFalse(raw instanceof dev.spectroscope.core.provider.RetryingProvider,
                "maxRetries=0 leaves the concrete provider unwrapped");
    }

    @Test
    void providerFromConfigInjectsTheAutologgingProxy(@TempDir Path projectDir) {
        // The CONCRETE provider is Logged-wrapped BEFORE the
        // retry decorator, so per-attempt entry/exit shows at DEBUG.
        var raw = SpectroConfig.load(
                new SpectroConfig.Overrides("ollama", null, null, null, null, null), projectDir,
                java.util.Map.of("SPECTRO_MAX_RETRIES", "0"))
                .providerFromConfig();
        assertTrue(java.lang.reflect.Proxy.isProxyClass(raw.getClass()),
                "the autologging proxy sits around the concrete provider");
    }

    private static SpectroConfig configFor(String provider, String baseUrl) {
        return new SpectroConfig(provider, "some-model", baseUrl, 100000, "ask", List.of(),
                "gemini", true, List.of(), 2, true, List.of(), null, "info",
                null, null, null);
    }

    // ---- logLevel ------------------------------------------------------

    @Test
    void logLevelDefaultsToInfo(@TempDir Path projectDir) {
        assertEquals("info",
                SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir).logLevel());
    }

    @Test
    void logLevelFollowsThePrecedenceChain(@TempDir Path projectDir) throws IOException {
        writeProjectSettings(projectDir, """
                { "logLevel": "debug" }
                """);
        assertEquals("debug",
                SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir).logLevel(),
                "the settings file sets the file-appender detail");

        var env = java.util.Map.of("SPECTRO_LOG_LEVEL", "trace");
        // flipped 2026-07-18: settings call the shots, env is the base
        assertEquals("debug",
                SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env).logLevel(),
                "the settings file beats the environment");
    }

    @Test
    void aMistypedLogLevelFailsLoudlyNeverSilently() {
        // The HookConfig lesson: a typo must not silently disable what the
        // owner configured — name the value and the allowed set.
        var env = java.util.Map.of("SPECTRO_LOG_LEVEL", "verbose");
        IllegalArgumentException failure = org.junit.jupiter.api.Assertions.assertThrows(
                IllegalArgumentException.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), Path.of("."), env));
        org.junit.jupiter.api.Assertions.assertTrue(failure.getMessage().contains("verbose"),
                "names the bad value, got: " + failure.getMessage());
        org.junit.jupiter.api.Assertions.assertTrue(failure.getMessage().contains("debug"),
                "names the allowed set, got: " + failure.getMessage());
    }

    @Test
    void providerHostNamesTheActiveBackendsNetworkCounterpart() {
        // The UI (header chip, trace host column) shows where requests really go.
        assertEquals("api.anthropic.com",
                configFor("anthropic", "http://localhost:11434").providerHost());
        assertEquals("localhost:11434",
                configFor("ollama", "http://localhost:11434").providerHost());
        // openai follows the EFFECTIVE url, not the raw config value; the
        // untouched-default swap itself is pinned deterministically below
        // (providerHost on the default would depend on the machine's env).
        assertEquals("my-gpu-box:8000",
                configFor("openai", "http://my-gpu-box:8000/v1").providerHost());
        // The two new OpenAI-compatible providers name their own preset hosts.
        assertEquals("localhost:1234",
                configFor("lmstudio", "http://localhost:11434").providerHost());
        assertEquals("openrouter.ai",
                configFor("openrouter", "http://localhost:11434").providerHost());
        // openai no longer depends on the key — it is always the cloud host.
        assertEquals("api.openai.com",
                configFor("openai", "http://localhost:11434").providerHost());
        // An unparseable url degrades to the raw value instead of throwing.
        assertEquals("not a url", configFor("ollama", "not a url").providerHost());
    }

    @Test
    void effectiveOpenAiBaseUrlUsesEachProvidersPreset() {
        // No more silent key-based swap: each OpenAI-compatible provider has an
        // explicit preset endpoint, so openai never quietly becomes LM Studio.
        assertEquals("https://api.openai.com",
                SpectroConfig.effectiveOpenAiBaseUrl("openai", "http://localhost:11434"));
        assertEquals("http://localhost:1234",
                SpectroConfig.effectiveOpenAiBaseUrl("lmstudio", "http://localhost:11434"));
        assertEquals("https://openrouter.ai/api",
                SpectroConfig.effectiveOpenAiBaseUrl("openrouter", "http://localhost:11434"));
        assertEquals("https://generativelanguage.googleapis.com/v1beta/openai",
                SpectroConfig.effectiveOpenAiBaseUrl("gemini", "http://localhost:11434"));
        // An explicit (non-default) baseUrl always wins for any of them.
        assertEquals("http://my-box:8000",
                SpectroConfig.effectiveOpenAiBaseUrl("openai", "http://my-box:8000"));
        assertEquals("http://my-box:8000",
                SpectroConfig.effectiveOpenAiBaseUrl("lmstudio", "http://my-box:8000"));
    }

    @Test
    void apiKeyRoundTripsThroughTheDotEnvWriteAndRead() throws java.io.IOException {
        // Hermetic: the build test-home persists between runs, so start clean.
        java.nio.file.Files.deleteIfExists(SpectroConfig.dotEnvPath());
        // The UI's 'save key' writes ~/.spectro/.env; resolveApiKey reads it back
        // (user.home points into the build dir for tests). No key set -> null.
        assertNull(SpectroConfig.resolveApiKey("OPENROUTER_API_KEY"));
        assertFalse(SpectroConfig.hasApiKey("OPENROUTER_API_KEY"));

        SpectroConfig.writeApiKey("OPENROUTER_API_KEY", "sk-or-test");
        assertEquals("sk-or-test", SpectroConfig.resolveApiKey("OPENROUTER_API_KEY"));
        assertTrue(SpectroConfig.hasApiKey("OPENROUTER_API_KEY"));

        // Upsert: writing again replaces the line, never duplicates it.
        SpectroConfig.writeApiKey("OPENROUTER_API_KEY", "sk-or-second");
        assertEquals("sk-or-second", SpectroConfig.resolveApiKey("OPENROUTER_API_KEY"));
        long lines = java.nio.file.Files.readAllLines(SpectroConfig.dotEnvPath()).stream()
                .filter(l -> l.startsWith("OPENROUTER_API_KEY=")).count();
        assertEquals(1, lines);
        java.nio.file.Files.deleteIfExists(SpectroConfig.dotEnvPath()); // don't leak into the build dir
    }

    @Test
    void imageEnvOverlaysADotEnvKeySoUiSavedKeysReachTheImageSubsystem() throws java.io.IOException {
        // The point of 'set key in UI': a GEMINI_API_KEY written to ~/.spectro/.env
        // must reach the IMAGE subsystem too, not just chat — image generation reads
        // its key from this map. Skip if the test JVM already exports the var.
        org.junit.jupiter.api.Assumptions.assumeTrue(System.getenv("GEMINI_API_KEY") == null);
        java.nio.file.Files.deleteIfExists(SpectroConfig.dotEnvPath());
        assertNull(SpectroConfig.imageEnv().get("GEMINI_API_KEY"));

        SpectroConfig.writeApiKey("GEMINI_API_KEY", "AI-test");
        assertEquals("AI-test", SpectroConfig.imageEnv().get("GEMINI_API_KEY"),
                "a UI-saved .env key must surface in the image env");
        // the process environment still passes through untouched.
        assertEquals(System.getenv("PATH"), SpectroConfig.imageEnv().get("PATH"));

        java.nio.file.Files.deleteIfExists(SpectroConfig.dotEnvPath());
    }

    @Test
    void imageEnvOverlaysWhenTheProcessVarIsPresentButBlank() throws java.io.IOException {
        // Same precedence as resolveApiKey: a blank env var counts as ABSENT, so the
        // .env key must still surface — otherwise chat works (resolveApiKey skips
        // blank) while image fails (it kept the blank), which is the reported bug.
        java.nio.file.Files.deleteIfExists(SpectroConfig.dotEnvPath());
        SpectroConfig.writeApiKey("GEMINI_API_KEY", "AI-from-dotenv");

        // blank process var -> .env wins
        assertEquals("AI-from-dotenv",
                SpectroConfig.imageEnvFrom(java.util.Map.of("GEMINI_API_KEY", "")).get("GEMINI_API_KEY"));
        // a real process var still wins over .env
        assertEquals("AI-from-env",
                SpectroConfig.imageEnvFrom(java.util.Map.of("GEMINI_API_KEY", "AI-from-env")).get("GEMINI_API_KEY"));
        // absent -> .env overlay
        assertEquals("AI-from-dotenv",
                SpectroConfig.imageEnvFrom(java.util.Map.of()).get("GEMINI_API_KEY"));

        java.nio.file.Files.deleteIfExists(SpectroConfig.dotEnvPath());
    }

    @Test
    void keyEnvNamesTheApiProvidersSecretAndIsNullForLocalOnes() {
        assertEquals("ANTHROPIC_API_KEY", SpectroConfig.keyEnvFor("anthropic"));
        assertEquals("OPENAI_API_KEY", SpectroConfig.keyEnvFor("openai"));
        assertEquals("OPENROUTER_API_KEY", SpectroConfig.keyEnvFor("openrouter"));
        assertEquals("GEMINI_API_KEY", SpectroConfig.keyEnvFor("gemini"));
        // The local backends need no key — reachability decides them instead.
        assertNull(SpectroConfig.keyEnvFor("ollama"));
        assertNull(SpectroConfig.keyEnvFor("lmstudio"));
    }

    @Test
    void onboardingStatusReflectsKeyPresenceForApiProvidersAndLocalForTheRest() {
        // API providers: ready once the key is set, needs-key otherwise.
        assertEquals("needs-key", SpectroConfig.onboardingStatus("anthropic", false));
        assertEquals("ready", SpectroConfig.onboardingStatus("anthropic", true));
        assertEquals("needs-key", SpectroConfig.onboardingStatus("openrouter", false));
        // Local backends never need a key — their readiness is a reachability
        // question the model list answers, not a key check.
        assertEquals("local", SpectroConfig.onboardingStatus("ollama", true));
        assertEquals("local", SpectroConfig.onboardingStatus("lmstudio", false));
    }

    // ---- imageModel / sttModel / chromeBinary (settings productization) ----------------

    @Test
    void theThreeNewFieldsRideEveryLayer(@TempDir Path projectDir) throws IOException {
        writeProjectSettings(projectDir, """
                { "imageModel": "gpt-image-2", "sttModel": "/models/ggml-small.bin" }
                """);
        var env = java.util.Map.of("SPECTRO_CHROME", "/opt/chromium");

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env);
        assertEquals("gpt-image-2", config.imageModel());
        assertEquals("/models/ggml-small.bin", config.sttModel());
        assertEquals("/opt/chromium", config.chromeBinary());
    }

    @Test
    void newFieldsDefaultToNull(@TempDir Path projectDir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());
        assertNull(config.imageModel());
        assertNull(config.sttModel());
        assertNull(config.chromeBinary());
    }

    @Test
    void envSuppliesImageModelAndSttModel(@TempDir Path projectDir) {
        var env = java.util.Map.of(
                "SPECTRO_IMAGE_MODEL", "gemini-2.5-flash-image",
                "SPECTRO_STT_MODEL", "/abs/ggml-large.bin");
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env);
        assertEquals("gemini-2.5-flash-image", config.imageModel());
        assertEquals("/abs/ggml-large.bin", config.sttModel());
    }

    @Test
    void chromeEnvOverlaysTheConfiguredBinary(@TempDir Path projectDir) throws IOException {
        writeProjectSettings(projectDir, """
                { "chromeBinary": "/custom/chrome" }
                """);
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());
        assertEquals("/custom/chrome", config.chromeEnv().get("SPECTRO_CHROME"));
    }

    @Test
    void chromeEnvWithoutABinaryIsTheProcessEnv(@TempDir Path projectDir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());
        // No configured binary: the map is the live process env (SPECTRO_CHROME absent or whatever the shell has).
        assertEquals(System.getenv().getOrDefault("SPECTRO_CHROME", null),
                config.chromeEnv().get("SPECTRO_CHROME"));
    }

    @Test
    void withProviderCopiesEveryOtherField(@TempDir Path projectDir) throws IOException {
        writeProjectSettings(projectDir, """
                { "autoApprove": ["run_command:ls*"], "imageModel": "gpt-image-2", "thinking": false }
                """);
        SpectroConfig base = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());

        SpectroConfig switched = base.withProvider("ollama", "qwen3");
        assertEquals("ollama", switched.provider());
        assertEquals("qwen3", switched.model());
        assertEquals(base.autoApprove(), switched.autoApprove());
        assertEquals("gpt-image-2", switched.imageModel());
        assertFalse(switched.thinking());
        assertEquals(base.baseUrl(), switched.baseUrl());
    }

    // ---- the precedence flip (settings productization Task 4) --------------------------
    // Ascending order becomes defaults < env < user settings < project settings < flags —
    // the env base sits directly above the defaults; settings FILES now call the shots.

    @Test
    void settingsFilesBeatTheEnvironmentAfterTheFlip(@TempDir Path projectDir) throws IOException {
        writeProjectSettings(projectDir, """
                { "provider": "anthropic" }
                """);
        var env = java.util.Map.of("SPECTRO_PROVIDER", "ollama", "SPECTRO_MODEL", "llama3.1");

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env);
        assertEquals("anthropic", config.provider(), "a settings file outranks the env base");
        assertEquals("llama3.1", config.model(), "env still fills what no file states");
    }

    @Test
    void flagsStillBeatEverything(@TempDir Path projectDir) throws IOException {
        writeProjectSettings(projectDir, """
                { "provider": "anthropic" }
                """);
        var env = java.util.Map.of("SPECTRO_PROVIDER", "ollama");
        SpectroConfig flagged = SpectroConfig.load(
                new SpectroConfig.Overrides("openai", null, null, null, null, null), projectDir, env);
        assertEquals("openai", flagged.provider());
    }

    @Test
    void envIsTheBaseDirectlyAboveTheDefaults(@TempDir Path projectDir) {
        var env = java.util.Map.of("SPECTRO_PROVIDER", "ollama");
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env);
        assertEquals("ollama", config.provider(), "with no files, env seeds the base");
    }

    @Test
    void userSettingsJsonWinsOverLegacyConfigJson(@TempDir Path projectDir) throws IOException {
        writeUserConfig("""
                { "provider": "ollama", "model": "legacy-model" }
                """);
        writeUserSettings("""
                { "provider": "anthropic" }
                """);
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());
        assertEquals("anthropic", config.provider(), "settings.json wins");
        assertEquals("legacy-model", config.model(), "config.json still fills gaps for one release");
    }

    // ---- workspace scopes (settings productization Task 5) -----------------------------
    // Ascending order grows to defaults < env < user settings < launch-dir settings <
    // workspace settings.json (project) < workspace settings.local.json (local) < flags —
    // the folder the agent actually works in speaks loudest short of a flag.

    @Test
    void workspaceScopesOutrankLaunchDirAndLocalOutranksProject(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        writeProjectSettings(projectDir, """
                { "provider": "anthropic", "model": "from-launch-dir" }
                """);
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "model": "from-ws-project", "thinking": false }
                """);
        Files.writeString(ws.resolve(".spectro/settings.local.json"), """
                { "model": "from-ws-local" }
                """);

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, ws, java.util.Map.of());
        assertEquals("anthropic", config.provider(), "launch-dir still fills what ws scopes omit");
        assertEquals("from-ws-local", config.model(), "local beats project beats launch-dir");
        assertFalse(config.thinking());
    }

    @Test
    void workspaceProjectBeatsLaunchDirWithNoLocalFilePresent(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // Final wave (fix 10): workspaceScopesOutrankLaunchDirAndLocalOutranksProject
        // above always writes BOTH a ws project AND a ws local file, so it never
        // isolates "project alone beats launch-dir" — local's presence could in
        // principle be masking a broken project-vs-launch-dir ordering. This test
        // sets no local file at all.
        writeProjectSettings(projectDir, """
                { "provider": "anthropic", "model": "from-launch-dir" }
                """);
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "model": "from-ws-project" }
                """);

        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, ws, java.util.Map.of());
        assertEquals("from-ws-project", config.model(),
                "the workspace project scope beats launch-dir even with no local file in play");
    }

    @Test
    void aNullWorkspaceIsTheProcessMomentView(@TempDir Path projectDir) throws IOException {
        writeProjectSettings(projectDir, """
                { "model": "launch-dir-model" }
                """);
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, null, java.util.Map.of());
        assertEquals("launch-dir-model", config.model());
    }

    @Test
    void aWorkspaceScopeMustNotPointAtAnotherWorkspace(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "workspace": "/somewhere/else" }
                """);
        IllegalArgumentException loud = assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, ws, java.util.Map.of()));
        assertTrue(loud.getMessage().contains("workspace"), loud.getMessage());
        assertTrue(loud.getMessage().contains("settings.json"), "the message names the offending file");
    }

    @Test
    void aWorkspaceScopeMustNotSetTheProcessGlobalLogLevel(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.local.json"), """
                { "logLevel": "debug" }
                """);
        IllegalArgumentException loud = assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, ws, java.util.Map.of()));
        assertTrue(loud.getMessage().contains("logLevel"), loud.getMessage());
    }

    // ---- provenance (settings productization Task 6) -----------------------------------

    @Test
    void provenanceNamesWinnerAndShadowedPerField(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        writeUserSettings("""
                { "provider": "anthropic" }
                """);
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "provider": "openai" }
                """);
        var env = java.util.Map.of("SPECTRO_PROVIDER", "ollama");

        SpectroConfig.Resolved resolved = SpectroConfig.loadResolved(
                SpectroConfig.Overrides.none(), projectDir, ws, env);

        assertEquals("openai", resolved.config().provider());
        SpectroConfig.Origin origin = resolved.origins().get("provider");
        assertEquals("project", origin.winner());
        assertEquals(java.util.List.of("user", "env"), origin.shadowed());
        assertEquals("defaults", resolved.origins().get("model").winner());
    }

    @Test
    void blocksCarryBlockLevelProvenance(@TempDir Path projectDir, @TempDir Path ws) throws IOException {
        writeUserSettings("""
                { "mcpServers": { "notes": { "command": "/usr/bin/true" } } }
                """);
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "mcpServers": { "other": { "command": "/usr/bin/true" } } }
                """);
        SpectroConfig.Resolved resolved = SpectroConfig.loadResolved(
                SpectroConfig.Overrides.none(), projectDir, ws, java.util.Map.of());
        assertEquals("project", resolved.origins().get("mcpServers").winner(),
                "whole-block replacement names the winning BLOCK's layer");
        assertEquals(java.util.List.of("user"), resolved.origins().get("mcpServers").shadowed());
        assertEquals(1, resolved.config().mcpServers().size());
        assertEquals("other", resolved.config().mcpServers().getFirst().name());
    }

    @Test
    void theLayersViewCarriesOnlyNonEmptyScopes(@TempDir Path projectDir) throws IOException {
        writeProjectSettings(projectDir, """
                { "model": "x" }
                """);
        SpectroConfig.Resolved resolved = SpectroConfig.loadResolved(
                SpectroConfig.Overrides.none(), projectDir, null, java.util.Map.of());
        assertTrue(resolved.layers().containsKey("launch-dir"));
        assertFalse(resolved.layers().containsKey("local"), "an absent scope is absent, not {}");
        assertEquals("x", resolved.layers().get("launch-dir").path("model").asText());
    }

    // ---- seed-on-first-boot (settings productization Task 11) --------------------------

    @Test
    void seedMaterializesTheEnvBaseOnce(@TempDir Path projectDir) throws IOException {
        var env = java.util.Map.of("SPECTRO_PROVIDER", "ollama", "SPECTRO_MODEL", "gpt-oss:20b",
                "SPECTRO_WORKSPACE", "/Users/x/SpectroDemo", "ANTHROPIC_API_KEY", "sk-secret");
        assertTrue(SpectroConfig.ensureSeeded(env), "the doctor face reports true when it actually seeded");

        String seeded = Files.readString(SpectroConfig.USER_SETTINGS_PATH);
        assertTrue(seeded.contains("\"ollama\""));
        assertTrue(seeded.contains("/Users/x/SpectroDemo"));
        assertFalse(seeded.contains("sk-secret"), "secrets NEVER enter the seed");
        assertFalse(seeded.contains("ANTHROPIC_API_KEY"));

        // Day-one equivalence: the seeded file yields the exact same effective config.
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());
        assertEquals("ollama", config.provider());
        assertEquals("gpt-oss:20b", config.model());
    }

    @Test
    void seedIsANoOpWhenAnyUserFileExists(@TempDir Path projectDir) throws IOException {
        writeUserConfig("""
                { "provider": "anthropic" }
                """);
        assertFalse(SpectroConfig.ensureSeeded(java.util.Map.of("SPECTRO_PROVIDER", "ollama")),
                "nothing was seeded — an existing scope must report false, not just stay silent");
        assertFalse(Files.exists(SpectroConfig.USER_SETTINGS_PATH),
                "an existing config.json means the user HAS a user scope — never overwrite");
    }

    @Test
    void seedWithAnEmptyEnvWritesNothing(@TempDir Path projectDir) {
        assertFalse(SpectroConfig.ensureSeeded(java.util.Map.of("PATH", "/usr/bin")),
                "nothing to seed — must report false");
        assertFalse(Files.exists(SpectroConfig.USER_SETTINGS_PATH));
    }
}
