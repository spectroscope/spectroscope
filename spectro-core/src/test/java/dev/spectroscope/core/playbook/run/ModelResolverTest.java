package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.playbook.Playbook;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ModelResolverTest {

    static final Playbook.ModelRef OLLAMA = new Playbook.ModelRef("ollama", "qwen3:8b");
    static final Playbook.ModelRef LMSTUDIO = new Playbook.ModelRef("lmstudio", "qwen3-8b");
    static final Playbook.ModelRef ANTHROPIC = new Playbook.ModelRef("anthropic", "claude-opus-5-5");

    static Probe down(String provider) {
        return new Probe(provider, "local", "failed", "http://localhost:11434", "refused", List.of(), false, 5L);
    }

    static Probe up(String provider, String kind, String model) {
        return new Probe(provider, kind, "reachable", "http://localhost:1234", null, List.of(model), true, 5L);
    }

    @Test
    void aPrivateStepNeverWalksItsFallbacks() {
        List<String> asked = new ArrayList<>();
        Map<String, Probe> rows = Map.of("ollama", down("ollama"), "lmstudio", up("lmstudio", "local", "qwen3-8b"));
        ModelResolver.Resolution r = ModelResolver.resolve(new Playbook.ModelChoice(OLLAMA, List.of(LMSTUDIO)),
                "private", p -> { asked.add(p); return rows.get(p); });
        ModelResolver.Unavailable u = assertInstanceOf(ModelResolver.Unavailable.class, r);
        assertEquals(List.of("ollama"), asked, "no fallback is asked");
        assertEquals("ollama qwen3:8b does not answer at http://localhost:11434 (refused)", u.sentence());
    }

    @Test
    void aPrivateStepRefusesACloudPrimary() {
        ModelResolver.Resolution r = ModelResolver.resolve(new Playbook.ModelChoice(ANTHROPIC, List.of()),
                "private", p -> up("anthropic", "cloud", "claude-opus-5-5"));
        ModelResolver.Unavailable u = assertInstanceOf(ModelResolver.Unavailable.class, r);
        assertTrue(u.sentence().contains("private step"), u.sentence());
    }

    @Test
    void aCheapStepWalksToTheFirstThatServesAndRecordsTheWalk() {
        Map<String, Probe> rows = Map.of("ollama", down("ollama"), "lmstudio", up("lmstudio", "local", "qwen3-8b"));
        ModelResolver.Resolution r = ModelResolver.resolve(new Playbook.ModelChoice(OLLAMA, List.of(LMSTUDIO)),
                "cheap", rows::get);
        ModelResolver.Resolved ok = assertInstanceOf(ModelResolver.Resolved.class, r);
        assertEquals(LMSTUDIO, ok.ref());
        assertEquals(List.of(OLLAMA), ok.walked());
    }

    @Test
    void aProviderThatAnswersWithoutTheModelIsNamedForIt() {
        ModelResolver.Resolution r = ModelResolver.resolve(new Playbook.ModelChoice(OLLAMA, List.of()), "cheap",
                p -> up("ollama", "local", "llama4"));
        ModelResolver.Unavailable u = assertInstanceOf(ModelResolver.Unavailable.class, r);
        assertEquals("ollama answers at http://localhost:1234 but does not list qwen3:8b", u.sentence());
    }

    /**
     * Card 584, criterion 7: a provider without an address of its own (the
     * Anthropic SDK's fixed endpoint) is named by its default address instead
     * of "no address".
     */
    @Test
    void aProbeWithoutAnAddressNamesTheProvidersDefaultAddress() {
        Probe rejected = new Probe("anthropic", "cloud", "failed", null, "rejected-key", List.of(), false, 5L);
        ModelResolver.Unavailable u = assertInstanceOf(ModelResolver.Unavailable.class, ModelResolver.resolve(
                new Playbook.ModelChoice(ANTHROPIC, List.of()), "cheap", p -> rejected));

        assertEquals("anthropic claude-opus-5-5 does not answer at the default address of anthropic (rejected-key)",
                u.sentence());
        assertTrue(!u.sentence().contains("no address"), u.sentence());
    }

    /** Card 584: one reason word per model that does not serve, for the start sheet. */
    @Test
    void theCodeOfAModelThatDoesNotServeIsOneWord() {
        Probe rejected = new Probe("anthropic", "cloud", "failed", null, "rejected-key", List.of(), false, 5L);
        Probe needsKey = new Probe("openai", "cloud", "needs-key", null, null, List.of(), false, 0L);
        Playbook.ModelChoice cloud = new Playbook.ModelChoice(ANTHROPIC, List.of());

        assertEquals("rejected-key", unavailable(cloud, "cheap", rejected).code());
        assertEquals("refused", unavailable(new Playbook.ModelChoice(OLLAMA, List.of()), "cheap", down("ollama")).code());
        assertEquals("not-listed", unavailable(new Playbook.ModelChoice(OLLAMA, List.of()), "cheap",
                up("ollama", "local", "llama4")).code());
        assertEquals("private-on-cloud", unavailable(cloud, "private", up("anthropic", "cloud", "claude-opus-5-5")).code());
        assertEquals("needs-key", unavailable(new Playbook.ModelChoice(new Playbook.ModelRef("openai", "gpt-5"),
                List.of()), "cheap", needsKey).code());
    }

    private static ModelResolver.Unavailable unavailable(Playbook.ModelChoice choice, String privacy, Probe row) {
        return assertInstanceOf(ModelResolver.Unavailable.class, ModelResolver.resolve(choice, privacy, p -> row));
    }

    /**
     * Review D2: Ollama is a local server, but it forwards a model whose tag is
     * cloud or ends in -cloud to its cloud. Such a model counts as cloud for a
     * private step, also when the playbook names it itself.
     */
    @Test
    void anOllamaCloudModelIsCloudForAPrivateStep() {
        Probe ollama = new Probe("ollama", "local", "reachable", "http://localhost:11434", null,
                List.of("minimax-m3:cloud", "gpt-oss:120b-cloud", "qwen3:8b", "cloudy:7b"), true, 5L);
        for (String model : List.of("minimax-m3:cloud", "gpt-oss:120b-cloud")) {
            Playbook.ModelChoice choice = new Playbook.ModelChoice(new Playbook.ModelRef("ollama", model), List.of());
            ModelResolver.Unavailable u = unavailable(choice, "private", ollama);
            assertEquals("private-on-cloud", u.code());
            assertEquals("ollama " + model + " is a cloud model and this is a private step", u.sentence());
            assertInstanceOf(ModelResolver.Resolved.class, ModelResolver.resolve(choice, "cheap", p -> ollama),
                    "a cheap step may run on it");
        }
        for (String model : List.of("qwen3:8b", "cloudy:7b")) {
            assertInstanceOf(ModelResolver.Resolved.class, ModelResolver.resolve(new Playbook.ModelChoice(
                    new Playbook.ModelRef("ollama", model), List.of()), "private", p -> ollama), model);
        }
        assertTrue(ModelResolver.cloudModel(new Playbook.ModelRef("ollama", "kimi-k2.7-code:cloud")));
        assertTrue(!ModelResolver.cloudModel(new Playbook.ModelRef("lmstudio", "x:cloud")),
                "the naming is Ollama's");
        assertTrue(!ModelResolver.cloudModel(new Playbook.ModelRef("ollama", "cloud")), "no tag, no cloud");
    }
}
