package dev.spectroscope.core.config;

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


    /**
     * The rule a workspace scope may not break, checked on the OUTCOME.
     *
     * <p>CARD 369 is why this is a helper and not seven copies of
     * {@code assertThrows}. Those cases pinned the MECHANISM — a load that threw
     * — and the mechanism moved: a forbidden key is now dropped while the file's
     * legal keys apply, so the throw is gone and the rule is not. Asserting on
     * the report and on the effective config says the thing the cards actually
     * decided, and it would have survived this change without being touched.</p>
     *
     * @param projectDir the launch directory
     * @param ws         the workspace whose scope names the key
     * @param key        the process-global key it must not get
     * @return the effective config, for a caller that wants to check the value too
     */
    private static SpectroConfig ruleHolds(Path projectDir, Path ws, String key) {
        SpectroConfig.ScopeReport report =
                SpectroConfig.reportFor(projectDir, ws, java.util.Map.of());
        assertTrue(report.dropped().contains(key),
                "a workspace scope set \"" + key + "\" and the load kept it: " + report.dropped());
        assertTrue(report.file() != null && report.file().contains(".spectro"),
                "the report names the file it came from: " + report.file());
        return SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, ws,
                java.util.Map.of());
    }

    @Test
    void defaultsApplyWithoutAnyFile(@TempDir Path projectDir) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals("anthropic", config.provider());
        assertEquals("claude-opus-4-8", config.model());
        // Card 263: with nothing configured the threshold is UNSET, not 100,000.
        // The constant moved out of the config and into the derivation, where
        // "nobody said anything" can finally be told apart from "the operator
        // typed 100000" — the distinction the old int made impossible.
        assertNull(config.compactionThreshold(),
                "an unset threshold stays unset, so the harness can derive it");
        assertEquals("ask", config.permissionMode());
        assertEquals(List.of(), config.autoApprove());
    }

    @Test
    void anUnsetThresholdIsReportedAsUnsetToTheSettingsFaceAsWell(@TempDir Path projectDir) {
        // The review's open question about the settings popover, measured
        // instead of read: making the field nullable changes what
        // GET /api/settings reports for it, and this is that report. `effective`
        // carries null and no layer claims the field, which is the popover's
        // documented "not set" path — the same one imageModel and sttModel have
        // always taken (workspaceGear.formatOverrideValue answers "" for null so
        // the row can say "not set" in the reader's own language). What the
        // harness is really compacting at is then the context ring's business.
        SpectroConfig.Resolved resolved = SpectroConfig.loadResolved(
                SpectroConfig.Overrides.none(), projectDir, null, Map.of());

        assertNull(resolved.config().compactionThreshold());
        // Measured, not assumed: the provenance still names the defaults layer.
        // That is the honest reading — the DEFAULT is now "unset" rather than
        // 100,000 — and it keeps the row from losing its origin chip while its
        // value goes empty.
        assertEquals("defaults", resolved.origins().get("compactionThreshold").winner());
        assertEquals(List.of(), resolved.origins().get("compactionThreshold").shadowed(),
                "nothing shadows a default nobody overrode");
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
        // lmstudio serves whatever model is loaded, ignoring the id — it must NOT
        // inherit the Claude default (that was the "opus for lmstudio" bug).
        assertEquals("local-model", SpectroConfig.load(
                new SpectroConfig.Overrides("lmstudio", null, null, null, null, null), projectDir).model());
    }

    @Test
    void defaultModelForResolvesEachProvidersDefault() {
        // The shared source for boot resolution AND the live picker switch: a
        // switch must land on the TARGET's default, never carry the old model.
        assertEquals("qwen3", SpectroConfig.defaultModelFor("ollama"));
        assertEquals("local-model", SpectroConfig.defaultModelFor("lmstudio"));
        assertEquals("local-model", SpectroConfig.defaultModelFor("openai"));
        assertEquals("claude-opus-4-8", SpectroConfig.defaultModelFor("anthropic"));
        // gemini/openrouter have NO honest default — null, so a switch asks for a
        // model instead of fabricating the Claude id under a non-Claude endpoint.
        assertNull(SpectroConfig.defaultModelFor("gemini"));
        assertNull(SpectroConfig.defaultModelFor("openrouter"));
    }

    @Test
    void switchRequiresKeyOnlyForKeyRequiringCloudProviders() {
        assertTrue(SpectroConfig.switchRequiresKey("anthropic"));
        assertTrue(SpectroConfig.switchRequiresKey("gemini"));
        assertTrue(SpectroConfig.switchRequiresKey("openrouter"));
        // Local backends need no key; openai is the keyless-capable compat escape hatch.
        assertFalse(SpectroConfig.switchRequiresKey("ollama"));
        assertFalse(SpectroConfig.switchRequiresKey("lmstudio"));
        assertFalse(SpectroConfig.switchRequiresKey("openai"));
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

    // Card 224: the plus menu writes {"enabled": false} into an entry instead of
    // deleting it — the server stays configured (its command stays readable on
    // the settings page), only the next agent build skips it. An entry written
    // before the flag existed has no "enabled" key and stays on.
    @Test
    void anMcpServerCanBeSwitchedOffInPlaceAndTheFlagSurvivesTheParse(@TempDir Path projectDir)
            throws IOException {
        writeUserConfig("""
                {
                  "mcpServers": {
                    "notes": { "command": "java", "enabled": false },
                    "tavily": { "command": "npx", "args": ["-y", "tavily-mcp"] }
                  }
                }
                """);
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir);
        assertEquals(2, config.mcpServers().size(),
                "a disabled entry stays configured — the registry skips it, the list keeps it");
        var notes = config.mcpServers().stream()
                .filter(s -> s.name().equals("notes")).findFirst().orElseThrow();
        var tavily = config.mcpServers().stream()
                .filter(s -> s.name().equals("tavily")).findFirst().orElseThrow();
        assertFalse(notes.enabledOrDefault(), "an explicit false switches the entry off");
        assertTrue(tavily.enabledOrDefault(), "no flag means on — every pre-flag config");
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
    void agentsMdFromWorkspaceIsWrappedIntoASystemPromptSection(@TempDir Path workspace) throws IOException {
        assertEquals("", SpectroConfig.loadAgentsMd(workspace), "absent AGENTS.md → empty string");
        Files.writeString(workspace.resolve("AGENTS.md"), "Always run the tests; never touch generated/.");
        String section = SpectroConfig.loadAgentsMd(workspace);
        assertTrue(section.contains("## Agent instructions (AGENTS.md)"), section);
        assertTrue(section.contains("never touch generated/"), section);
    }

    @Test
    void loadAgentsMdToleratesANullWorkspace() {
        // Some prompt-building paths (e.g. the stateless context endpoint) may not
        // have a resolved workspace — that is "absent", not a crash.
        assertEquals("", SpectroConfig.loadAgentsMd(null));
    }

    @Test
    void projectMdAndAgentsMdBothAppendWhenEachIsPresent(@TempDir Path projectDir, @TempDir Path workspace)
            throws IOException {
        // SPECTRO.md is the project's context (project root); AGENTS.md is the
        // cross-tool agent-instructions convention (the workspace). Different
        // scopes, different files — both append, neither shadows the other.
        Files.writeString(projectDir.resolve("SPECTRO.md"), "project rules here");
        Files.writeString(workspace.resolve("AGENTS.md"), "agent rules here");
        String combined = SpectroConfig.loadProjectMd(projectDir) + SpectroConfig.loadAgentsMd(workspace);
        assertTrue(combined.contains("## Project context (SPECTRO.md)"), combined);
        assertTrue(combined.contains("project rules here"), combined);
        assertTrue(combined.contains("## Agent instructions (AGENTS.md)"), combined);
        assertTrue(combined.contains("agent rules here"), combined);
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
        return configFor(provider, baseUrl, null, null);
    }

    private static SpectroConfig configFor(String provider, String baseUrl,
            String ollamaBaseUrl, String lmstudioBaseUrl) {
        return new SpectroConfig(provider, "some-model", baseUrl, 100000, "ask", List.of(),
                "gemini", true, List.of(), 2, true, List.of(), null, "info",
                null, null, "auto", "auto", null, null, null,
                ollamaBaseUrl, lmstudioBaseUrl, null, false, false);
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

    // ---- per-provider addresses (card 193) ------------------------------------------

    @Test
    void perProviderAddressesKeepOllamaAndLmstudioApart(@TempDir Path projectDir) throws IOException {
        // Card 193: ONE baseUrl used to serve every provider, so pointing it at
        // an LM Studio box made ollama dial the same host, wrong port and all.
        // Each local-model provider now carries its own address.
        writeProjectSettings(projectDir, """
                { "ollamaBaseUrl": "http://gpu-box:11434", "lmstudioBaseUrl": "http://gpu-box:1234" }
                """);
        SpectroConfig config = SpectroConfig.load(
                SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());
        assertEquals("http://gpu-box:11434", config.endpointFor("ollama"));
        assertEquals("http://gpu-box:1234", config.endpointFor("lmstudio"));
    }

    @Test
    void legacyBaseUrlConfigsKeepWorkingWhenNoPerProviderAddressIsSet(@TempDir Path projectDir)
            throws IOException {
        // Backward compatibility: a config that only knows the shared baseUrl
        // behaves exactly as before this card — both local providers read it.
        writeProjectSettings(projectDir, """
                { "baseUrl": "http://legacy-box:9999" }
                """);
        SpectroConfig config = SpectroConfig.load(
                SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());
        assertEquals("http://legacy-box:9999", config.endpointFor("ollama"));
        assertEquals("http://legacy-box:9999", config.endpointFor("lmstudio"));
    }

    @Test
    void withNothingConfiguredEachLocalProviderDialsItsOwnPreset(@TempDir Path projectDir) {
        SpectroConfig config = SpectroConfig.load(
                SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());
        assertEquals("http://localhost:11434", config.endpointFor("ollama"));
        assertEquals("http://localhost:1234", config.endpointFor("lmstudio"));
    }

    @Test
    void aProvidersOwnDefaultIsNeverAnUnsetSentinelForThePerProviderFields() {
        // The second trap of card 193: on the legacy field, the literal
        // http://localhost:11434 doubles as "unset". The NEW fields take every
        // non-blank value verbatim — a deliberately typed default is a value,
        // never a silent reroute to some preset.
        assertEquals("http://localhost:11434",
                SpectroConfig.effectiveLmstudioBaseUrl("http://localhost:11434", null));
        assertEquals("http://localhost:1234",
                SpectroConfig.effectiveOllamaBaseUrl("http://localhost:1234", "http://elsewhere:1"));
        // Only null/blank means unset on the new fields — then the legacy chain runs.
        assertEquals("http://legacy:2", SpectroConfig.effectiveOllamaBaseUrl(" ", "http://legacy:2"));
        // The legacy sentinel itself survives on the legacy field: an untouched
        // shared baseUrl still routes lmstudio to its own preset.
        assertEquals("http://localhost:1234",
                SpectroConfig.effectiveLmstudioBaseUrl(null, "http://localhost:11434"));
    }

    @Test
    void perProviderAddressesRideTheEnvLayer(@TempDir Path projectDir) {
        var env = java.util.Map.of(
                "SPECTRO_OLLAMA_BASE_URL", "http://gpu-box:11434",
                "SPECTRO_LMSTUDIO_BASE_URL", "http://gpu-box:1234");
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, env);
        assertEquals("http://gpu-box:11434", config.ollamaBaseUrl());
        assertEquals("http://gpu-box:1234", config.lmstudioBaseUrl());
    }

    @Test
    void providerHostFollowsThePerProviderAddress() {
        // The header chip / trace host column says where requests really go —
        // including a per-provider address.
        assertEquals("gpu-box:11434",
                configFor("ollama", "http://localhost:11434", "http://gpu-box:11434", null)
                        .providerHost());
        assertEquals("gpu-box:1234",
                configFor("lmstudio", "http://localhost:11434", null, "http://gpu-box:1234")
                        .providerHost());
    }

    @Test
    void switchingProviderSwitchesTheEndpointAndBackAgain(@TempDir Path projectDir)
            throws IOException {
        // Card 192's scenario, satisfied here: ollama configured at one host,
        // LM Studio at another; a provider switch switches the endpoint with
        // it, switching back restores the first, and neither host is ever
        // handed to the other provider.
        writeProjectSettings(projectDir, """
                { "provider": "ollama",
                  "ollamaBaseUrl": "http://ollama-box:11434",
                  "lmstudioBaseUrl": "http://lmstudio-box:1234" }
                """);
        SpectroConfig onOllama = SpectroConfig.load(
                SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());
        assertEquals("ollama-box:11434", onOllama.providerHost());

        SpectroConfig onLmstudio = onOllama.withProvider("lmstudio", "some-model");
        assertEquals("lmstudio-box:1234", onLmstudio.providerHost(),
                "the switch carries LM Studio to ITS host, not ollama's");

        SpectroConfig backOnOllama = onLmstudio.withProvider("ollama", "qwen3");
        assertEquals("ollama-box:11434", backOnOllama.providerHost(),
                "switching back restores the first host");
    }

    @Test
    void aLanPerProviderAddressStaysKeylessAndClassifiedLocal() {
        // Card 192's other measurement, kept intact: isLocalEndpoint accepts
        // private-range hosts, so a workstation on the LAN needs no cloud key.
        // The per-provider address must flow through the SAME classification.
        //
        // The fallback is a PUBLIC gateway on purpose. This test used to leave
        // the legacy baseUrl at ollama's default, whose lmstudio fallback is
        // http://localhost:1234 — also local, also keyless. Both assertions
        // therefore passed just as well when the per-provider address was
        // ignored ENTIRELY (measured: endpointFor patched to drop it, test
        // still green), so it pinned isLocalEndpoint and not the flow-through
        // its comment claimed. A test green in both directions pins nothing.
        SpectroConfig config = configFor("lmstudio", "https://gateway.example.com",
                null, "http://192.168.1.50:1234");
        String endpoint = config.endpointFor("lmstudio");
        assertEquals("http://192.168.1.50:1234", endpoint,
                "the LAN address is what lmstudio dials — the shared fallback is a"
                        + " public gateway and must not be reached at all");
        assertTrue(SpectroConfig.isLocalEndpoint(endpoint),
                "a LAN address counts as the operator's own network: " + endpoint);
        assertEquals("local", SpectroConfig.onboardingStatusAt("lmstudio", endpoint, false),
                "keyless and honest — never needs-key against the operator's own box");
    }

    @Test
    void endpointForRefusesProvidersWithoutAConfigurableEndpoint() {
        // anthropic's endpoint is fixed in the SDK; spectro-local is a
        // subprocess, not an address. Answering something would be a lie.
        assertThrows(IllegalArgumentException.class,
                () -> configFor("anthropic", null).endpointFor("anthropic"));
        assertThrows(IllegalArgumentException.class,
                () -> configFor("ollama", null).endpointFor("spectro-local"));
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

    // ---- sttLanguage (the dictation language, both transcription routes) ----

    @Test
    void sttLanguageDefaultsToAutoRidesTheSettingsFileAndTheEnv(@TempDir Path projectDir)
            throws IOException {
        assertEquals("auto", SpectroConfig.load(
                SpectroConfig.Overrides.none(), projectDir, java.util.Map.of()).sttLanguage());

        // The env layer sits directly above the defaults ...
        var env = java.util.Map.of("SPECTRO_STT_LANGUAGE", "en");
        assertEquals("en", SpectroConfig.load(
                SpectroConfig.Overrides.none(), projectDir, env).sttLanguage());

        // ... and is outranked by every settings file, like every other field.
        writeProjectSettings(projectDir, """
                { "sttLanguage": "de" }
                """);
        assertEquals("de", SpectroConfig.load(
                SpectroConfig.Overrides.none(), projectDir, env).sttLanguage());
    }

    @Test
    void anUnknownSttLanguageFailsLoudlyInsteadOfSilentlyMisdirectingDictation(
            @TempDir Path projectDir) throws IOException {
        writeProjectSettings(projectDir, """
                { "sttLanguage": "klingon" }
                """);
        var thrown = org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, java.util.Map.of()));
        assertTrue(thrown.getMessage().contains("sttLanguage"), thrown.getMessage());
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
                { "autoApprove": ["run_command:ls*"], "imageModel": "gpt-image-2", "thinking": false,
                  "ollamaBaseUrl": "http://gpu-box:11434", "lmstudioBaseUrl": "http://gpu-box:1234" }
                """);
        SpectroConfig base = SpectroConfig.load(SpectroConfig.Overrides.none(), projectDir, java.util.Map.of());

        SpectroConfig switched = base.withProvider("ollama", "qwen3");
        assertEquals("ollama", switched.provider());
        assertEquals("qwen3", switched.model());
        assertEquals(base.autoApprove(), switched.autoApprove());
        assertEquals("gpt-image-2", switched.imageModel());
        assertFalse(switched.thinking());
        assertEquals(base.baseUrl(), switched.baseUrl());
        // Card 193: a mid-session switch must not drop the per-provider addresses.
        assertEquals("http://gpu-box:11434", switched.ollamaBaseUrl());
        assertEquals("http://gpu-box:1234", switched.lmstudioBaseUrl());
    }

    @Test
    void withProviderCopiesEveryRecordComponentWithoutBeingToldTheirNames() throws Exception {
        // The named-field test above asserts six of the record's components, so
        // it is blind to exactly the failure a positional copy produces: growing
        // the record forces a COMPILE error when a component is forgotten, but a
        // component handed the wrong VALUE — ollamaBaseUrl copied into
        // lmstudioBaseUrl, the two Strings that sit side by side — compiles,
        // ships, and points a run at the other provider's machine.
        //
        // Every String below is distinct on purpose: two components that carry
        // the same value cannot be told apart after a swap. The canonical
        // constructor is used deliberately — a new component breaks THIS line,
        // and whoever fixes it has to give it a value of its own before the loop
        // can mean anything.
        SpectroConfig base = new SpectroConfig(
                "anthropic", "model-component", "baseUrl-component", 12345, "auto",
                List.of("run_command:ls*"), "openai", false, List.of(), 7, false, List.of(),
                "workspace-component", "debug", "imageModel-component", "sttModel-component",
                "local", "de", "chromeBinary-component",
                "otlpEndpoint-component", "otlpBasicAuth-component",
                "ollamaBaseUrl-component", "lmstudioBaseUrl-component",
                "searxngUrl-component",
                true,    // allowLocalhost: distinct from the false default, card 199
                true,    // headlessMcp: distinct from the false default, card 220
                // Card 262/266's counts, each distinct from its shipped default
                // so a swapped int is visible too.
                11, 12, 13, 14, 15,
                // Card 312: llama.cpp's own address. It sits LAST in the record
                // and next to nothing, but it is still a String the switch could
                // drop — and a null here would let the loop pass vacuously.
                "llamacppBaseUrl-component");

        SpectroConfig switched = base.withProvider("ollama", "qwen3");

        var components = SpectroConfig.class.getRecordComponents();
        assertTrue(components.length >= 24,
                "reflection found " + components.length + " components — if this list ever"
                        + " shrinks to nothing the loop below silently asserts nothing");
        int checked = 0;
        for (var component : components) {
            String name = component.getName();
            if ("provider".equals(name) || "model".equals(name)) {
                continue; // the two the switch is FOR
            }
            assertEquals(component.getAccessor().invoke(base),
                    component.getAccessor().invoke(switched),
                    "withProvider dropped or mis-copied \"" + name + "\" — it copies"
                            + " positionally, so a component handed the neighbouring value"
                            + " compiles and ships silently");
            checked++;
        }
        assertEquals(components.length - 2, checked,
                "every component except provider and model must be compared");
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
    void aWorkspaceScopeMustNotOpenTheNetFence(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // Card 199, review finding F4: the workspace IS the agent's cwd, and
        // write_file writes into it. A fence whose only switch sits inside the
        // sandbox it guards is not a fence — one auto-approved write and the next
        // session reaches loopback, which the redirect fix then extends no
        // further, but loopback alone is the board, ollama and the whole local
        // machine.
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "allowLocalhost": true }
                """);
        ruleHolds(projectDir, ws, "allowLocalhost");

        Files.delete(ws.resolve(".spectro/settings.json"));
        Files.writeString(ws.resolve(".spectro/settings.local.json"), """
                { "allowLocalhost": true }
                """);
                // Card 369: the local half, on the outcome. "the local half is written by the same hand:"
        SpectroConfig.ScopeReport local =
                SpectroConfig.reportFor(projectDir, ws, java.util.Map.of());
        assertTrue(local.file().contains("settings.local.json"),
                "the report names the local file: " + local.file());
        assertFalse(local.dropped().isEmpty(),
                "and it refused the key there too");
    }

    @Test
    void aWorkspaceScopeMustNotPointAtAnotherWorkspace(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "workspace": "/somewhere/else" }
                """);
                // Card 369: the RULE, checked on the outcome. It used to be checked on
        // a throw, and the throw is gone — the key is dropped and the file's
        // legal keys apply. What the card decided is unchanged.
        ruleHolds(projectDir, ws, "workspace");
        assertTrue(SpectroConfig.reportFor(projectDir, ws, java.util.Map.of())
                .file().contains("settings.json"),
                "the report names the offending file");
    }

    @Test
    void aWorkspaceScopeMustNotNameTheBrowserBinary(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // Card 222, review finding F2. The same rule as the fence above, and the
        // reason it was missed is that chromeBinary does not LOOK like a switch:
        // it names an executable browse_page launches. An operator approving
        // "browse_page https://…" approves a look at a page, not the launch of a
        // binary the agent picked — and the agent's own write_file writes into
        // exactly this folder. Card 222 shortened the reach of such a file from
        // "the next session" to "the next tool call", which is what made a
        // sleeping hole an awake one.
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.local.json"), """
                { "chromeBinary": "/tmp/not-a-browser.sh" }
                """);
                // Card 369: the RULE, checked on the outcome. It used to be checked on
        // a throw, and the throw is gone — the key is dropped and the file's
        // legal keys apply. What the card decided is unchanged.
        ruleHolds(projectDir, ws, "chromeBinary");
        assertTrue(SpectroConfig.reportFor(projectDir, ws, java.util.Map.of())
                .file().contains("settings.local.json"),
                "the report names the offending file");
        // The hint now rides on the refusal in the report rather than in a
        // thrown message — same sentence, same source, card 369 moved only
        // where it is read from.
        assertTrue(SpectroConfig.reportFor(projectDir, ws, java.util.Map.of())
                .only().hint().contains("SPECTRO_CHROME"),
                "the refusal says where the key belongs instead");
    }

    @Test
    void aWorkspaceScopeMustNotRedirectWebSearch(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        // The quieter twin, named by the same review. SearxngSearcher takes no
        // NetFence at all, so this key decides an address web_search GETs with
        // the loopback opt-in still off — an agent that writes it points every
        // later search of that session at a machine it chose and reads the
        // answer back into its own context. The settings page writes this key
        // to the user scope, so refusing it here costs the operator nothing.
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.json"), """
                { "searxngUrl": "http://127.0.0.1:9999" }
                """);
                // Card 369: the RULE, checked on the outcome. It used to be checked on
        // a throw, and the throw is gone — the key is dropped and the file's
        // legal keys apply. What the card decided is unchanged.
        ruleHolds(projectDir, ws, "searxngUrl");
        // The hint now rides on the refusal in the report rather than in a
        // thrown message — same sentence, same source, card 369 moved only
        // where it is read from.
        assertTrue(SpectroConfig.reportFor(projectDir, ws, java.util.Map.of())
                .only().hint().contains("SPECTRO_SEARXNG_URL"),
                "the refusal says where the key belongs instead");
    }

    @Test
    void aWorkspaceScopeMustNotSetTheProcessGlobalLogLevel(@TempDir Path projectDir, @TempDir Path ws)
            throws IOException {
        Files.createDirectories(ws.resolve(".spectro"));
        Files.writeString(ws.resolve(".spectro/settings.local.json"), """
                { "logLevel": "debug" }
                """);
                // Card 369: the RULE, checked on the outcome. It used to be checked on
        // a throw, and the throw is gone — the key is dropped and the file's
        // legal keys apply. What the card decided is unchanged.
        ruleHolds(projectDir, ws, "logLevel");
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

    @Test
    void spectroLocalIsAKeylessKnownProvider() {
        assertTrue(SpectroConfig.isKnownProvider("spectro-local"));
        assertNull(SpectroConfig.keyEnvFor("spectro-local"), "local, no key");
        // Not a literal any more. This line used to read "vibethinker-3b" and that
        // is exactly how the two defaults drifted apart: the catalogue moved its
        // default to Qwen3 4B and this constant stayed put, so a picker switch
        // silently started the tool-free row. The catalogue is the single source;
        // LocalCatalogDefaultTest pins what that default must be able to do.
        assertEquals(dev.spectroscope.core.local.LocalCatalog.bundled().defaultId(),
                SpectroConfig.defaultModelFor("spectro-local"));
    }

    @Test
    void spectroLocalStatusReflectsModelPresence() {
        assertEquals("ready", SpectroConfig.localModelStatus(true));
        assertEquals("needs-download", SpectroConfig.localModelStatus(false));
    }

    @Test
    void spectroLocalCannotBeBuiltFromThePureConfigPath() {
        // The pure config path cannot start a subprocess — spectro-local must go
        // through the runtime layer (LocalProviderFactory). Fail readably, not
        // with a cryptic "Unknown provider".
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "spectro-local", null, null, null, null, null));   // flags win over user settings
        IllegalStateException e = assertThrows(IllegalStateException.class, config::providerFromConfig);
        assertTrue(e.getMessage().contains("local runtime"), "readable pointer at the runtime layer");
    }

    @Test
    void loopbackAndPrivateHostsAreLocalEndpoints() {
        for (String url : List.of("http://localhost:1234", "http://127.0.0.1:8000",
                "http://[::1]:1234", "http://LM-Studio.local:1234", "http://192.168.1.5:1234",
                "http://10.0.0.9:8000", "http://172.16.4.4:1234", "http://172.31.0.1:1234")) {
            assertTrue(SpectroConfig.isLocalEndpoint(url), url + " is not a public service");
        }
    }

    @Test
    void everythingElseCountsAsPublic() {
        // Anything unrecognised must err towards asking for the key, never
        // towards a green light: that direction is the whole point.
        for (String url : List.of("https://api.openai.com", "https://openrouter.ai/api",
                "https://generativelanguage.googleapis.com/v1beta/openai",
                "http://172.32.0.1:1234", "http://1270.0.0.1", "not a url at all", "",
                // A private range is a range of ADDRESSES. These three are public
                // DNS names that merely START like one, and a string-prefix match
                // handed all three the operator's-own-network verdict.
                "http://10.example.com", "http://192.168.example.com",
                "http://172.16.example.com", "http://127.0.0.1.evil.example",
                "http://10.0.0.999")) {
            assertFalse(SpectroConfig.isLocalEndpoint(url), url + " is not on this machine");
        }
        assertFalse(SpectroConfig.isLocalEndpoint(null));
    }

    @Test
    void aKeylessCloudEndpointNeedsItsKeyAndALocalOneDoesNot() {
        assertEquals("needs-key",
                SpectroConfig.onboardingStatusAt("openai", "https://api.openai.com", false));
        assertEquals("ready",
                SpectroConfig.onboardingStatusAt("openai", "https://api.openai.com", true));
        // The generic openai escape hatch pointed at a keyless local server —
        // the case switchRequiresKey already tolerates.
        assertEquals("local",
                SpectroConfig.onboardingStatusAt("openai", "http://localhost:1234", false));
        // A provider with no key variable at all stays local wherever it points.
        assertEquals("local",
                SpectroConfig.onboardingStatusAt("lmstudio", "https://example.com", false));
    }
}
