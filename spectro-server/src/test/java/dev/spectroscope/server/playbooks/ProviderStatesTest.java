package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.server.providers.ListResult;
import dev.spectroscope.server.providers.ProviderRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The step table answers from the provider registry, not from the presence words. */
class ProviderStatesTest {

    @TempDir Path tmp;

    private static SpectroConfig config() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }

    private static ProviderRegistry registryAnswering(ListResult answer) {
        return new ProviderRegistry((provider, c) -> answer, () -> 1_000_000L);
    }

    private PlaybookLoader.Loaded loadMinimal(ProviderStates states) throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("pb"));
        Files.writeString(dir.resolve("playbook.json"), PlaybookLoaderTest.MINIMAL);
        Path skill = Files.createDirectories(dir.resolve("skills/spectropowers/brainstorming"));
        Files.writeString(skill.resolve("SKILL.md"), "---\nname: brainstorming\ndescription: d\n---\nbody\n");
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        return PlaybookLoader.load(dir, ws, config(), states);
    }

    @Test
    void aStepWhoseProviderTheRegistryReportsFailedGetsStateFailedWithTheRegistrysReason() throws IOException {
        ProviderRegistry registry = registryAnswering(ListResult.failed("refused", "http://localhost:11434"));
        registry.check("ollama", config());

        PlaybookLoader.ModelState model = loadMinimal(ProviderStates.over(registry)).steps().get(0).model();

        assertEquals("ollama", model.provider());
        assertEquals("failed", model.state());
        assertEquals("refused", model.reason());
        assertTrue(model.unverified(), "a failed provider verifies no model");
    }

    @Test
    void aReachableProviderWithTheModelInItsLiveListIsVerified() throws IOException {
        ProviderRegistry registry = registryAnswering(ListResult.ok(List.of("qwen3:8b", "other"), "http://localhost:11434"));
        registry.check("ollama", config());

        PlaybookLoader.ModelState model = loadMinimal(ProviderStates.over(registry)).steps().get(0).model();

        assertEquals("reachable", model.state());
        assertFalse(model.reason().isBlank());
        assertFalse(model.unverified());
    }

    @Test
    void aReachableProviderWithoutTheModelInItsLiveListIsUnverified() throws IOException {
        ProviderRegistry registry = registryAnswering(ListResult.ok(List.of("other"), "http://localhost:11434"));
        registry.check("ollama", config());

        PlaybookLoader.ModelState model = loadMinimal(ProviderStates.over(registry)).steps().get(0).model();

        assertEquals("reachable", model.state());
        assertTrue(model.unverified(), "the list is live and does not name qwen3:8b");
    }

    @Test
    void aProviderNeverCheckedIsConfiguredAndUnverified() throws IOException {
        ProviderRegistry registry = registryAnswering(ListResult.ok(List.of("qwen3:8b"), "http://localhost:11434"));

        PlaybookLoader.ModelState model = loadMinimal(ProviderStates.over(registry)).steps().get(0).model();

        assertEquals("configured", model.state());
        assertTrue(model.unverified(), "no check has run, so no list has confirmed the model");
    }

    @Test
    void aProviderTheRegistryDoesNotKnowFallsBackToThePresenceWord() {
        ProviderRegistry registry = registryAnswering(ListResult.ok(List.of(), "x"));

        ProviderStates.State state = ProviderStates.over(registry).of("no-such-provider", "m", config());

        assertEquals("unknown", state.state());
        assertTrue(state.unverified());
    }

    @Test
    void theLoadersDefaultReadsTheSharedRegistryNotThePresenceWords() {
        // The presence words call a keyless ollama "local"; the registry calls it "configured" until a check ran.
        ProviderStates.State state = ProviderStates.current().of("ollama", "qwen3:8b", config());

        assertEquals("configured", state.state());
    }
}
