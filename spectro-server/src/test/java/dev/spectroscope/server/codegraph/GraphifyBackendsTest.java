package dev.spectroscope.server.codegraph;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 472: the sheet's backend list is the harness's own provider list, and
 * each entry maps to one of graphify's backends plus the environment that
 * backend reads. Nothing outside the list becomes an argument.
 */
class GraphifyBackendsTest {

    /** Where each provider would be dialled, as the config would answer. */
    private static final Function<String, String> ENDPOINTS = provider -> switch (provider) {
        case "ollama" -> "http://localhost:11434";
        case "lmstudio" -> "http://localhost:1234";
        case "llamacpp" -> "http://localhost:8080";
        case "openai" -> "https://api.openai.com";
        case "openrouter" -> "https://openrouter.ai/api";
        case "gemini" -> "https://generativelanguage.googleapis.com/v1beta/openai";
        default -> throw new IllegalArgumentException("no endpoint for " + provider);
    };

    private static Function<String, String> keys(Map<String, String> saved) {
        return saved::get;
    }

    /** What every provider's model list answers, as /api/models would. */
    private static Function<String, List<String>> listing(String... ids) {
        return provider -> List.of(ids);
    }

    /** A saved key for every keyed provider, so only the rule under test can refuse. */
    private static final Function<String, String> EVERY_KEY = env -> "test-key";

    @Test
    void everyProviderTheHarnessKnowsIsEitherOfferedOrLeftOutWithAReason() {
        Set<String> offered = GraphifyBackends.offered(keys(Map.of())).stream()
                .map(GraphifyBackends.Choice::provider).collect(Collectors.toSet());
        Map<String, String> leftOut = GraphifyBackends.leftOut();

        Set<String> both = new HashSet<>(offered);
        both.addAll(leftOut.keySet());
        assertEquals(SpectroConfig.knownProviders(), both,
                "the sheet's list is the harness's own list, every name accounted for");
        assertTrue(offered.stream().noneMatch(leftOut::containsKey), "a provider is offered or left out, never both");
        assertEquals(Map.of("spectro-local", GraphifyBackends.NO_ADDRESS,
                        "copilot", GraphifyBackends.NO_ADDRESS), leftOut,
                "the bundled runtime and the Copilot runtime are subprocesses with no address graphify could dial");
    }

    @Test
    void theListFollowsTheHarnessOrderAndMapsEachProviderToAGraphifyBackend() {
        List<String> display = List.of(SpectroConfig.KNOWN_PROVIDERS_DISPLAY.split(",\\s*"));
        List<GraphifyBackends.Choice> offered = GraphifyBackends.offered(keys(Map.of()));

        List<String> names = offered.stream().map(GraphifyBackends.Choice::provider).toList();
        assertEquals(display.stream().filter(names::contains).toList(), names);
        for (GraphifyBackends.Choice choice : offered) {
            assertTrue(GraphifyCommand.BACKENDS.contains(choice.backend()), choice.backend());
        }
    }

    @Test
    void aProviderAddedToTheHarnessListThatSpeaksTheOpenAiWireIsOfferedWithoutAnyEditHere() {
        List<String> harness = new ArrayList<>(SpectroConfig.knownProviders());
        harness.add("newcompat");
        harness.add("newsubprocess");
        Predicate<String> openAiCompat = p -> "newcompat".equals(p)
                || SpectroConfig.openAiCompatProviders().contains(p);

        List<GraphifyBackends.Choice> offered = GraphifyBackends.offered(harness, openAiCompat, keys(Map.of()));
        GraphifyBackends.Choice added = offered.stream()
                .filter(c -> c.provider().equals("newcompat")).findFirst().orElseThrow();

        assertEquals("openai", added.backend());
        assertEquals(Map.of("spectro-local", GraphifyBackends.NO_ADDRESS,
                        "copilot", GraphifyBackends.NO_ADDRESS,
                        "newsubprocess", GraphifyBackends.NO_ADDRESS),
                GraphifyBackends.leftOut(harness, openAiCompat));
    }

    @Test
    void graphifysNativeBackendsAreNamedOnlyForProvidersTheHarnessKnows() {
        for (String provider : GraphifyBackends.NATIVE.keySet()) {
            assertTrue(SpectroConfig.isKnownProvider(provider), provider);
        }
    }

    @Test
    void aKeyedProviderWithoutASavedKeyIsListedButNotReady() {
        GraphifyBackends.Choice anthropic = GraphifyBackends.offered(keys(Map.of())).stream()
                .filter(c -> c.provider().equals("anthropic")).findFirst().orElseThrow();

        assertFalse(anthropic.ready());
        assertEquals("no key saved for anthropic", anthropic.reason());
    }

    @Test
    void aLocalProviderNeedsNoKeyAndIsReady() {
        GraphifyBackends.Choice ollama = GraphifyBackends.offered(keys(Map.of())).stream()
                .filter(c -> c.provider().equals("ollama")).findFirst().orElseThrow();

        assertTrue(ollama.ready());
        assertNull(ollama.reason());
    }

    @Test
    void anthropicBecomesTheClaudeBackendWithItsKeyInTheEnvironmentNeverOnTheCommandLine() {
        GraphifyBackends.Resolved resolved = GraphifyBackends.resolve("anthropic", "claude-haiku-4-5",
                ENDPOINTS, keys(Map.of("ANTHROPIC_API_KEY", "test-key-a")), listing("claude-haiku-4-5"));

        assertEquals(new GraphifyCommand.Naming("claude", "claude-haiku-4-5"), resolved.naming());
        assertEquals(Map.of("ANTHROPIC_API_KEY", "test-key-a"), resolved.env());
    }

    @Test
    void ollamaBecomesTheOllamaBackendDialledAtTheConfiguredAddress() {
        GraphifyBackends.Resolved resolved = GraphifyBackends.resolve("ollama", "qwen3:8b",
                ENDPOINTS, keys(Map.of()), listing("qwen3:8b"));

        assertEquals(new GraphifyCommand.Naming("ollama", "qwen3:8b"), resolved.naming());
        assertEquals(Map.of("OLLAMA_BASE_URL", "http://localhost:11434/v1"), resolved.env());
    }

    @Test
    void aLocalOpenAiCompatibleServerBecomesTheOpenAiBackendAtItsOwnAddress() {
        GraphifyBackends.Resolved resolved = GraphifyBackends.resolve("lmstudio", "some-model",
                ENDPOINTS, keys(Map.of("OPENAI_API_KEY", "must-not-leak-to-a-local-server")),
                listing("some-model"));

        assertEquals(new GraphifyCommand.Naming("openai", "some-model"), resolved.naming());
        assertEquals(Map.of("OPENAI_BASE_URL", "http://localhost:1234/v1",
                "OPENAI_API_KEY", GraphifyBackends.KEYLESS), resolved.env());
    }

    @Test
    void openRouterBecomesTheOpenAiBackendWithItsOwnKey() {
        GraphifyBackends.Resolved resolved = GraphifyBackends.resolve("openrouter", "openai/gpt-4o",
                ENDPOINTS, keys(Map.of("OPENROUTER_API_KEY", "test-key-r")), listing("openai/gpt-4o"));

        assertEquals(new GraphifyCommand.Naming("openai", "openai/gpt-4o"), resolved.naming());
        assertEquals(Map.of("OPENAI_BASE_URL", "https://openrouter.ai/api/v1",
                "OPENAI_API_KEY", "test-key-r"), resolved.env());
    }

    @Test
    void geminiBecomesTheGeminiBackendWithItsKeyAndAddress() {
        GraphifyBackends.Resolved resolved = GraphifyBackends.resolve("gemini", "gemini-2.5-flash",
                ENDPOINTS, keys(Map.of("GEMINI_API_KEY", "test-key-g")), listing("gemini-2.5-flash"));

        assertEquals(new GraphifyCommand.Naming("gemini", "gemini-2.5-flash"), resolved.naming());
        assertEquals(Map.of("GEMINI_API_KEY", "test-key-g",
                "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai"), resolved.env());
    }

    @Test
    void aProviderOutsideTheListIsRefusedBeforeItCanBecomeAnArgument() {
        // An address for every name, so the only thing that can refuse is the
        // list itself (a mutation bite found the endpoint lookup doing it).
        Function<String, String> anyAddress = provider -> "http://localhost:11434";
        for (String bad : List.of("spectro-local", "bedrock", "--backend=x", "ollama;id", "")) {
            IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                    () -> GraphifyBackends.resolve(bad, "m", anyAddress, keys(Map.of()), listing("m")), bad);
            assertEquals("not a provider the code graph can use", refused.getMessage());
        }
    }

    @Test
    void aKeyedProviderWithoutAKeyIsRefusedWithTheSameReasonTheSheetShows() {
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> GraphifyBackends.resolve("anthropic", "m", ENDPOINTS, keys(Map.of()), listing("m")));

        assertEquals("no key saved for anthropic", refused.getMessage());
    }

    @Test
    void aModelThatFailsTheArgumentRuleIsRefusedForEveryProvider() {
        List<GraphifyBackends.Choice> offered = GraphifyBackends.offered(EVERY_KEY);
        assertFalse(offered.isEmpty());
        Function<String, String> anyAddress = provider -> "http://localhost:11434";
        for (GraphifyBackends.Choice choice : offered) {
            // The list says yes, so only the argument rule can refuse.
            IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                    () -> GraphifyBackends.resolve(choice.provider(), "--force", anyAddress, EVERY_KEY,
                            listing("--force")), choice.provider());
            assertEquals("not a model name", refused.getMessage(), choice.provider());
        }
    }

    @Test
    void aModelTheProviderDoesNotListIsRefusedBeforeItBecomesAnArgument() {
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> GraphifyBackends.resolve("ollama", "llama3", ENDPOINTS, keys(Map.of()),
                        listing("qwen3:8b", "gemma3:4b")));

        assertEquals("not a model ollama lists", refused.getMessage());
    }

    @Test
    void aProviderThatListsNoModelsCannotNameCommunities() {
        IllegalArgumentException refused = assertThrows(IllegalArgumentException.class,
                () -> GraphifyBackends.resolve("lmstudio", "some-model", ENDPOINTS, keys(Map.of()), listing()));

        assertEquals("lmstudio lists no models", refused.getMessage());
    }

    @Test
    void theModelListIsAskedForTheChosenProviderOnly() {
        List<String> asked = new ArrayList<>();
        // lmstudio, whose graphify backend is "openai": the list is the provider's, not the backend's.
        GraphifyBackends.resolve("lmstudio", "some-model", ENDPOINTS, keys(Map.of()), provider -> {
            asked.add(provider);
            return List.of("some-model");
        });

        assertEquals(List.of("lmstudio"), asked);
    }
}
