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
}
