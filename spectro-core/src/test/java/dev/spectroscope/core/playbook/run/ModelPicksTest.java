package dev.spectroscope.core.playbook.run;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 584: the model picks of a start, as untrusted input from the page. They
 * read only as an object of node id to provider and model, name only nodes of
 * the pinned playbook that run on a model and providers the app knows, and a
 * pick must serve on a fresh check of its provider; a private node never takes
 * a cloud provider.
 */
class ModelPicksTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A cheap chat step, a private child step, a review decision and a command decision. */
    static final String PICKABLE = """
        { "schema_version": 1, "id": "p", "name": "P", "description": "d",
          "models": { "strong": { "primary": { "provider": "anthropic", "model": "claude-opus-5-5" } },
                      "fast":   { "primary": { "provider": "ollama", "model": "qwen3:8b" } },
                      "judge":  { "primary": { "provider": "anthropic", "model": "claude-fable-5-1" } } },
          "documents": { "plan": { "name": "Plan", "purpose": "p", "location": "plan.md", "sections": ["Tasks"] },
                         "code": { "name": "Code", "purpose": "c", "location": "code.md", "sections": ["Files"] } },
          "checks": { "plan_ok": { "kind": "command", "run": "test -f plan.md" },
                      "review": { "kind": "review", "model": "judge", "reads": ["plan"],
                                  "ask": "Is the plan complete?", "labels": ["pass", "fail"] } },
          "start": "write_plan",
          "nodes": [
            { "kind": "step", "id": "write_plan", "name": "Write plan", "performer": "chat", "model": "strong",
              "produces": ["plan"] },
            { "kind": "decision", "id": "plan_ok", "name": "Plan ok", "check": "plan_ok" },
            { "kind": "decision", "id": "plan_review", "name": "Plan review", "check": "review" },
            { "kind": "step", "id": "build", "name": "Build", "performer": "child", "role": "worker",
              "model": "fast", "privacy": "private", "consumes": ["plan"], "produces": ["code"] },
            { "kind": "end", "id": "done", "result": "done" },
            { "kind": "end", "id": "failed", "result": "failed" }
          ],
          "arrows": [
            { "from": "write_plan", "to": "plan_ok" },
            { "from": "plan_ok", "to": "plan_review", "on": "pass" },
            { "from": "plan_ok", "to": "failed", "on": "fail" },
            { "from": "plan_review", "to": "build", "on": "pass" },
            { "from": "plan_review", "to": "failed", "on": "fail" },
            { "from": "build", "to": "done" }
          ] }
        """;

    static Playbook pickable() {
        PlaybookReader.Read read = PlaybookReader.read(PICKABLE);
        assertEquals(List.of(), read.findings(), "premise: the fixture reads");
        return read.playbook();
    }

    private static final Set<String> KNOWN = Set.of("anthropic", "ollama", "lmstudio", "openai");

    private static Probe reachable(String provider, String kind, String... models) {
        return new Probe(provider, kind, "reachable", "http://localhost:11434", null, List.of(models), true, 1L);
    }

    /** ollama answers with two models; anthropic rejects the key; openai answers as a cloud. */
    private static Probe probe(String provider) {
        return switch (provider) {
            case "ollama" -> reachable("ollama", "local", "qwen3:8b", "llama3:8b");
            case "openai" -> reachable("openai", "cloud", "gpt-5");
            case "anthropic" -> new Probe("anthropic", "cloud", "failed", null, "rejected-key", List.of(), false, 1L);
            default -> new Probe(provider, "local", "failed", "http://localhost:1234", "refused", List.of(), false, 1L);
        };
    }

    private static JsonNode json(String text) throws IOException {
        return JSON.readTree(text);
    }

    private static Map<String, Playbook.ModelRef> picks(String text) throws IOException {
        ModelPicks.Read read = ModelPicks.read(json(text));
        assertNull(read.refusal(), "premise: the picks read");
        return read.picks();
    }

    // ---- the nodes that run on a model ------------------------------------ //

    @Test
    void everyStepAndEveryReviewDecisionRunsOnAModelInNodeOrder() {
        List<ModelPicks.Node> nodes = ModelPicks.nodes(pickable());

        assertEquals(List.of(
                new ModelPicks.Node("write_plan", "Write plan", "step", "strong", "cheap"),
                new ModelPicks.Node("plan_review", "Plan review", "review", "judge", "cheap"),
                new ModelPicks.Node("build", "Build", "step", "fast", "private")), nodes,
                "a command decision runs on no model and is not a node a pick can name");
    }

    @Test
    void aReviewReadingWhatAPrivateStepWroteIsPrivate() {
        String json = PICKABLE.replace("\"reads\": [\"plan\"]", "\"reads\": [\"code\"]");
        Playbook p = PlaybookReader.read(json).playbook();

        assertEquals("private", ModelPicks.nodes(p).get(1).privacy());
    }

    // ---- reading the frame ------------------------------------------------ //

    @Test
    void absentOrNullPicksReadAsNone() throws IOException {
        assertEquals(Map.of(), ModelPicks.read(null).picks());
        assertNull(ModelPicks.read(null).refusal());
        assertEquals(Map.of(), ModelPicks.read(json("{}").path("picks")).picks(), "a missing field");
        assertEquals(Map.of(), ModelPicks.read(json("{\"picks\":null}").path("picks")).picks());
        assertEquals(Map.of(), ModelPicks.read(json("{}")).picks(), "an empty object");
    }

    @Test
    void anObjectOfStepIdToProviderAndModelReads() throws IOException {
        Map<String, Playbook.ModelRef> read = picks("""
                {"write_plan": {"provider": "ollama", "model": "llama3:8b"},
                 "plan_review": {"provider": "openai", "model": "gpt-5"}}""");

        assertEquals(Map.of("write_plan", new Playbook.ModelRef("ollama", "llama3:8b"),
                "plan_review", new Playbook.ModelRef("openai", "gpt-5")), read);
    }

    @Test
    void everyShapeThatIsNotThatIsRefusedWithOneSentence() throws IOException {
        List<String> bad = new ArrayList<>(List.of(
                "[]",
                "\"ollama\"",
                "{\"write_plan\": \"ollama llama3:8b\"}",
                "{\"write_plan\": {\"provider\": \"ollama\"}}",
                "{\"write_plan\": {\"model\": \"llama3:8b\"}}",
                "{\"write_plan\": {\"provider\": 7, \"model\": \"llama3:8b\"}}",
                "{\"write_plan\": {\"provider\": \"ollama\", \"model\": [\"llama3:8b\"]}}",
                "{\"write_plan\": {\"provider\": \"ollama\", \"model\": \"  \"}}",
                "{\"write_plan\": {\"provider\": \"\", \"model\": \"llama3:8b\"}}",
                "{\"write_plan\": {\"provider\": \"ollama\", \"model\": \"llama3\\n8b\"}}",
                "{\"write_plan\": {\"provider\": \"ollama\", \"model\": \"" + "m".repeat(ModelPicks.MAX_MODEL_CHARS + 1) + "\"}}",
                "{\"write_plan\": {\"provider\": \"" + "p".repeat(ModelPicks.MAX_PROVIDER_CHARS + 1) + "\", \"model\": \"m\"}}",
                // Fix round (review N2): a node id longer than the bound, and one with a control character.
                "{\"" + "n".repeat(ModelPicks.MAX_NODE_CHARS + 1) + "\": {\"provider\": \"ollama\", \"model\": \"m\"}}",
                "{\"write\\tplan\": {\"provider\": \"ollama\", \"model\": \"m\"}}"));
        ObjectNode many = JsonNodeFactory.instance.objectNode();
        for (int i = 0; i <= ModelPicks.MAX_PICKS; i++) {
            many.putObject("s" + i).put("provider", "ollama").put("model", "m");
        }
        bad.add(many.toString());

        for (String text : bad) {
            ModelPicks.Read read = ModelPicks.read(json(text));
            assertEquals(ModelPicks.UNREADABLE, read.refusal(), text.length() > 80 ? text.substring(0, 80) : text);
            assertEquals(Map.of(), read.picks(), "a refused shape carries no pick");
        }
    }

    @Test
    void aNodeIdAtTheLimitStillReads() throws IOException {
        String id = "n".repeat(ModelPicks.MAX_NODE_CHARS);
        assertEquals(new Playbook.ModelRef("ollama", "m"),
                picks("{\"" + id + "\": {\"provider\": \"ollama\", \"model\": \"m\"}}").get(id));
    }

    @Test
    void aModelAtTheLimitStillReads() throws IOException {
        String model = "m".repeat(ModelPicks.MAX_MODEL_CHARS);
        assertEquals(model, picks("{\"write_plan\": {\"provider\": \"ollama\", \"model\": \"" + model + "\"}}")
                .get("write_plan").model());
    }

    // ---- checking the picks against the playbook and the providers -------- //

    @Test
    void picksThatServeOnTheirNodesAreAccepted() throws IOException {
        Map<String, Playbook.ModelRef> picks = picks("""
                {"write_plan": {"provider": "openai", "model": "gpt-5"},
                 "plan_review": {"provider": "ollama", "model": "llama3:8b"},
                 "build": {"provider": "ollama", "model": "llama3:8b"}}""");

        assertNull(ModelPicks.refusal(pickable(), picks, KNOWN::contains, ModelPicksTest::probe));
    }

    @Test
    void noPicksAreNoRefusalAndAskNoProvider() {
        List<String> asked = new ArrayList<>();
        assertNull(ModelPicks.refusal(pickable(), Map.of(), KNOWN::contains, p -> {
            asked.add(p);
            return probe(p);
        }));
        assertEquals(List.of(), asked);
    }

    @Test
    void aPickForANodeThatRunsOnNoModelOrIsNotThereIsRefused() throws IOException {
        for (String id : List.of("plan_ok", "done", "nowhere")) {
            String refusal = ModelPicks.refusal(pickable(),
                    picks("{\"" + id + "\": {\"provider\": \"ollama\", \"model\": \"llama3:8b\"}}"),
                    KNOWN::contains, ModelPicksTest::probe);
            assertEquals("The model pick names " + id + ", which is not a step of this playbook that runs on a model.",
                    refusal);
        }
    }

    @Test
    void aProviderTheAppDoesNotKnowIsRefusedBeforeAnythingIsAsked() throws IOException {
        List<String> asked = new ArrayList<>();
        String refusal = ModelPicks.refusal(pickable(),
                picks("{\"write_plan\": {\"provider\": \"evil\", \"model\": \"m\"}}"), KNOWN::contains, p -> {
                    asked.add(p);
                    return probe(p);
                });

        assertEquals("The model pick for write_plan names evil, which is not a provider this app knows.", refusal);
        assertEquals(List.of(), asked, "an unknown provider is never dialled");
    }

    @Test
    void aPrivateNodeRefusesACloudPick() throws IOException {
        String refusal = ModelPicks.refusal(pickable(),
                picks("{\"build\": {\"provider\": \"openai\", \"model\": \"gpt-5\"}}"),
                KNOWN::contains, ModelPicksTest::probe);

        assertEquals("The model pick for build does not serve: openai gpt-5 is a cloud provider and this is a"
                + " private step.", refusal);
    }

    @Test
    void aPickTheProviderDoesNotListOrThatDoesNotAnswerIsRefused() throws IOException {
        assertEquals("The model pick for write_plan does not serve: ollama answers at http://localhost:11434 but"
                        + " does not list nope.",
                ModelPicks.refusal(pickable(), picks("{\"write_plan\": {\"provider\": \"ollama\", \"model\": \"nope\"}}"),
                        KNOWN::contains, ModelPicksTest::probe));
        String rejected = ModelPicks.refusal(pickable(),
                picks("{\"write_plan\": {\"provider\": \"anthropic\", \"model\": \"claude-opus-5-5\"}}"),
                KNOWN::contains, ModelPicksTest::probe);
        assertNotNull(rejected);
        assertTrue(rejected.startsWith("The model pick for write_plan does not serve: anthropic claude-opus-5-5"
                + " does not answer"), rejected);
        assertTrue(rejected.contains("(rejected-key)"), rejected);
    }

    @Test
    void eachPickedProviderIsAskedOnce() throws IOException {
        List<String> asked = new ArrayList<>();
        ModelPicks.refusal(pickable(), picks("""
                {"write_plan": {"provider": "ollama", "model": "llama3:8b"},
                 "plan_review": {"provider": "ollama", "model": "qwen3:8b"},
                 "build": {"provider": "ollama", "model": "llama3:8b"}}"""), KNOWN::contains, p -> {
                    asked.add(p);
                    return probe(p);
                });

        assertEquals(List.of("ollama"), asked);
    }

    // ---- fix round: the server's own reading of a pick --------------------- //

    /** Review N4: a pick equal to the node's own primary is no pick, also when a hand-made frame sends it. */
    @Test
    void aPickEqualToThePlaybooksModelIsDroppedAndTheOthersStay() throws IOException {
        Map<String, Playbook.ModelRef> sent = picks("""
                {"write_plan": {"provider": "anthropic", "model": "claude-opus-5-5"},
                 "build": {"provider": "ollama", "model": "llama3:8b"},
                 "nowhere": {"provider": "ollama", "model": "qwen3:8b"}}""");

        assertEquals(Map.of("build", new Playbook.ModelRef("ollama", "llama3:8b"),
                "nowhere", new Playbook.ModelRef("ollama", "qwen3:8b")), ModelPicks.withoutDefaults(pickable(), sent),
                "a pick for a node that is not there stays, so the check still refuses it");
        assertEquals(Map.of(), ModelPicks.withoutDefaults(pickable(), Map.of()));
    }

    /** The checks that need no provider, apart, so a server can run them before it dials anything. */
    @Test
    void theStructuralCheckAsksNoProvider() throws IOException {
        assertEquals("The model pick names nowhere, which is not a step of this playbook that runs on a model.",
                ModelPicks.structuralRefusal(pickable(),
                        picks("{\"nowhere\": {\"provider\": \"ollama\", \"model\": \"m\"}}"), KNOWN::contains));
        assertEquals("The model pick for build names evil, which is not a provider this app knows.",
                ModelPicks.structuralRefusal(pickable(),
                        picks("{\"build\": {\"provider\": \"evil\", \"model\": \"m\"}}"), KNOWN::contains));
        assertNull(ModelPicks.structuralRefusal(pickable(),
                picks("{\"build\": {\"provider\": \"ollama\", \"model\": \"nope\"}}"), KNOWN::contains),
                "whether a model serves is the provider's to say");
    }

    /** Review D2: Ollama forwards a model tagged cloud to its cloud; a private node never takes one. */
    @Test
    void aPrivateNodeRefusesAnOllamaCloudModelAndACheapNodeTakesIt() throws IOException {
        Probe ollama = reachable("ollama", "local", "minimax-m3:cloud", "gpt-oss:120b-cloud", "qwen3:8b");
        for (String model : List.of("minimax-m3:cloud", "gpt-oss:120b-cloud")) {
            assertEquals("The model pick for build does not serve: ollama " + model + " is a cloud model and this is"
                    + " a private step.", ModelPicks.refusal(pickable(),
                    picks("{\"build\": {\"provider\": \"ollama\", \"model\": \"" + model + "\"}}"),
                    KNOWN::contains, p -> ollama));
            assertNull(ModelPicks.refusal(pickable(),
                    picks("{\"write_plan\": {\"provider\": \"ollama\", \"model\": \"" + model + "\"}}"),
                    KNOWN::contains, p -> ollama), "a cheap step may run on it");
        }
    }

    // ---- the effective choice --------------------------------------------- //

    @Test
    void aPickReplacesTheChoiceWithoutFallbacksAndAnUnpickedNodeKeepsThePlaybooks() {
        Playbook p = pickable();
        Playbook.ModelRef pick = new Playbook.ModelRef("ollama", "llama3:8b");
        Map<String, Playbook.ModelRef> picks = Map.of("write_plan", pick);

        assertEquals(new Playbook.ModelChoice(pick, List.of()), ModelPicks.choiceOf(p, "write_plan", "strong", picks));
        assertEquals(p.models().get("fast"), ModelPicks.choiceOf(p, "build", "fast", picks));
    }
}
