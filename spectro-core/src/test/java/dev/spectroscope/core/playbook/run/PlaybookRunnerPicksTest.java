package dev.spectroscope.core.playbook.run;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 584: a model picked in the start sheet holds for this run only. A
 * picked node runs on the pick instead of its choice, the step's records name
 * the pick, and a node without a pick runs on the playbook's model.
 */
class PlaybookRunnerPicksTest {

    @TempDir Path tmp;

    private static final Probe REJECTED = new Probe("anthropic", "cloud", "failed", null, "rejected-key",
            List.of(), false, 1L);

    static PlaybookRunner.Outcome run(Path tmp, String json, FakeHost host, Map<String, Playbook.ModelRef> picks)
            throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("pb"));
        Files.writeString(dir.resolve("playbook.json"), json);
        Playbook p = PlaybookReader.read(json).playbook();
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, p);
        PlaybookRecorder recorder = new PlaybookRecorder(tmp.resolve("s1.playbook.jsonl"),
                PlaybookRecorder.DEFAULT_CEILING_BYTES);
        PlaybookRunner.Setup setup = new PlaybookRunner.Setup(pinned, "abcdefabcdef",
                tmp.resolve("s1.abcdefabcdef.graph.jsonl"), recorder, host.signal, "auto", "add a CSV export",
                picks);
        return new PlaybookRunner(setup, host, StepChildOnGraphTest.manager(
                new StepChildOnGraphTest.OneTurn("chat", "unused")), line -> Optional.empty()).run();
    }

    private FakeHost host() throws IOException {
        FakeHost host = new FakeHost(Files.createDirectories(tmp.resolve("ws")));
        host.rows.put("anthropic", REJECTED);
        host.onChat.put("write_plan", h -> write(h.workspace.resolve("plan.md"), "# Tasks\nx\n"));
        return host;
    }

    @Test
    void aPickedChatStepRunsOnThePickAndItsRecordsNameIt() throws IOException {
        FakeHost host = host();
        Playbook.ModelRef pick = new Playbook.ModelRef("ollama", "qwen3:8b");

        PlaybookRunner.Outcome out = run(tmp, VocabularyTest.LOOP, host, Map.of("write_plan", pick));

        assertEquals(RunStop.DONE, out.stopReason(), out.detail());
        assertEquals(List.of("write_plan@ollama"), host.chatTurns, "the chat switched to the pick");
        assertFalse(host.probed.contains("anthropic"), "the playbook's model was never asked: " + host.probed);
        List<JsonNode> steps = PlaybookRunnerTest.sidecar(tmp, "step_start");
        assertEquals("ollama", steps.get(0).get("provider").asText());
        assertEquals("qwen3:8b", steps.get(0).get("model").asText());
        assertTrue(steps.get(0).get("picked").asBoolean(), "the step record says the model was picked");
        assertFalse(steps.get(1).path("picked").asBoolean(false), "build ran on the playbook's model");
        assertTrue(host.events.stream().anyMatch(e -> e instanceof RunEvent.PlaybookProgress pp
                && "write_plan".equals(pp.node()) && "ollama".equals(pp.provider()) && "qwen3:8b".equals(pp.model())),
                "the chat's step line names the pick");
        JsonNode start = PlaybookRunnerTest.sidecar(tmp, "playbook_start").get(0);
        assertEquals("ollama", start.path("picks").path("write_plan").path("provider").asText());
        assertEquals("qwen3:8b", start.path("picks").path("write_plan").path("model").asText());
    }

    @Test
    void withoutAPickTheRejectedModelStillStopsTheRun() throws IOException {
        FakeHost host = host();
        host.answers.put("Retry or stop?", "stop");

        PlaybookRunner.Outcome out = run(tmp, VocabularyTest.LOOP, host, Map.of());

        assertEquals(RunStop.MODEL_UNAVAILABLE, out.stopReason());
        assertTrue(out.detail().contains("the default address of anthropic"), out.detail());
        assertTrue(PlaybookRunnerTest.sidecar(tmp, "playbook_start").get(0).path("picks").isMissingNode(),
                "a run without picks records none");
    }

    @Test
    void aPickedChildStepBuildsItsProviderFromThePick() throws IOException {
        FakeHost host = host();
        host.rows.put("anthropic", new Probe("anthropic", "cloud", "reachable", null, null, List.of(), false, 1L));

        PlaybookRunner.Outcome out = run(tmp, VocabularyTest.LOOP, host,
                Map.of("build", new Playbook.ModelRef("lmstudio", "qwen3-8b")));

        assertEquals(RunStop.DONE, out.stopReason(), out.detail());
        assertTrue(host.events.stream().anyMatch(e -> e instanceof RunEvent.RunStart s
                && s.agentId().startsWith("worker-") && "lmstudio".equals(s.provider())
                && "qwen3-8b".equals(s.model())), "the child ran on the pick");
        assertFalse(host.probed.contains("ollama"), "the playbook's model of build was never asked: " + host.probed);
    }

    /** One chat step, then a review whose judge is anthropic. */
    static final String REVIEWED = """
        { "schema_version": 1, "id": "r", "name": "R", "description": "d",
          "models": { "fast":  { "primary": { "provider": "ollama", "model": "qwen3:8b" } },
                      "judge": { "primary": { "provider": "anthropic", "model": "claude-fable-5-1" } } },
          "documents": { "plan": { "name": "Plan", "purpose": "p", "location": "plan.md", "sections": ["Tasks"] } },
          "checks": { "review": { "kind": "review", "model": "judge", "reads": ["plan"],
                                  "ask": "Is the plan complete?", "labels": ["pass", "fail"] } },
          "start": "write_plan",
          "nodes": [
            { "kind": "step", "id": "write_plan", "name": "Write plan", "performer": "chat", "model": "fast",
              "produces": ["plan"] },
            { "kind": "decision", "id": "plan_review", "name": "Plan review", "check": "review" },
            { "kind": "end", "id": "done", "result": "done" },
            { "kind": "end", "id": "failed", "result": "failed" }
          ],
          "arrows": [
            { "from": "write_plan", "to": "plan_review" },
            { "from": "plan_review", "to": "done", "on": "pass" },
            { "from": "plan_review", "to": "failed", "on": "fail" }
          ] }
        """;

    @Test
    void aPickedReviewRunsItsJudgeOnThePick() throws IOException {
        FakeHost host = host();

        run(tmp, REVIEWED, host, Map.of("plan_review", new Playbook.ModelRef("lmstudio", "judge-local")));

        assertTrue(host.events.stream().anyMatch(e -> e instanceof RunEvent.RunStart s
                && s.agentId().startsWith("explore-") && "lmstudio".equals(s.provider())
                && "judge-local".equals(s.model())), "the review child ran on the pick");
        assertFalse(host.probed.contains("anthropic"), "the judge of the playbook was never asked: " + host.probed);
    }

    /** VocabularyTest.LOOP with write_plan private. */
    private static final String PRIVATE_ON_CLOUD = VocabularyTest.LOOP.replace(
            "\"model\": \"strong\", \"produces\"", "\"model\": \"strong\", \"privacy\": \"private\", \"produces\"");

    @Test
    void aLocalPickLiftsThePrivateStepRuleAndACloudPickKeepsIt() throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("priv"));
        Files.writeString(dir.resolve("playbook.json"), PRIVATE_ON_CLOUD);
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, PlaybookReader.read(PRIVATE_ON_CLOUD).playbook());
        Map<String, String> kinds = Map.of("anthropic", "cloud", "openai", "cloud", "ollama", "local");
        String rule = "write_plan: a private step may not run on the cloud provider ";

        assertTrue(PlaybookRunner.refusals(pinned, true, kinds::get).contains(rule + "anthropic"));
        assertFalse(PlaybookRunner.refusals(pinned, true, kinds::get,
                Map.of("write_plan", new Playbook.ModelRef("ollama", "qwen3:8b"))).stream()
                .anyMatch(r -> r.startsWith(rule)), "a local pick lifts it");
        assertTrue(PlaybookRunner.refusals(pinned, true, kinds::get,
                Map.of("write_plan", new Playbook.ModelRef("openai", "gpt-5"))).contains(rule + "openai"),
                "a cloud pick on a private step is refused by the run itself");
        assertFalse(PlaybookRunner.refusalsBesideModels(pinned, true).stream().anyMatch(r -> r.startsWith(rule)),
                "the sheet shows it on the step's row, where a pick can lift it");
    }

    /** Review D2: a private step whose own model is an Ollama cloud model is refused before the run. */
    @Test
    void aPrivateStepOnAnOllamaCloudModelIsRefused() throws IOException {
        String json = PRIVATE_ON_CLOUD.replace(
                "\"strong\": { \"primary\": { \"provider\": \"anthropic\", \"model\": \"claude-opus-5-5\" } }",
                "\"strong\": { \"primary\": { \"provider\": \"ollama\", \"model\": \"minimax-m3:cloud\" } }");
        Path dir = Files.createDirectories(tmp.resolve("ollama-cloud"));
        Files.writeString(dir.resolve("playbook.json"), json);
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, PlaybookReader.read(json).playbook());
        Map<String, String> kinds = Map.of("ollama", "local");

        assertTrue(PlaybookRunner.refusals(pinned, true, kinds::get).contains(
                "write_plan: a private step may not run on the cloud model ollama minimax-m3:cloud"),
                PlaybookRunner.refusals(pinned, true, kinds::get).toString());
        assertFalse(PlaybookRunner.refusals(pinned, true, kinds::get,
                Map.of("write_plan", new Playbook.ModelRef("ollama", "qwen3:8b"))).stream()
                .anyMatch(r -> r.startsWith("write_plan: a private step")), "a local model lifts it");
    }

    @Test
    void aRunOnALocalPickForAPrivateStepGoesThrough() throws IOException {
        FakeHost host = host();

        PlaybookRunner.Outcome out = run(tmp, PRIVATE_ON_CLOUD, host,
                Map.of("write_plan", new Playbook.ModelRef("ollama", "qwen3:8b")));

        assertEquals(RunStop.DONE, out.stopReason(), out.detail());
        assertEquals(List.of("write_plan@ollama"), host.chatTurns);
    }

    @Test
    void theSetupHoldsItsOwnCopyOfThePicks() throws IOException {
        Path dir = Files.createDirectories(tmp.resolve("copy"));
        Files.writeString(dir.resolve("playbook.json"), VocabularyTest.LOOP);
        PinnedPlaybook pinned = PinnedPlaybook.pin(dir, VocabularyTest.loop());
        Map<String, Playbook.ModelRef> picks = new HashMap<>();
        picks.put("write_plan", new Playbook.ModelRef("ollama", "qwen3:8b"));

        PlaybookRunner.Setup setup = new PlaybookRunner.Setup(pinned, "abcdefabcdef", tmp.resolve("g"), null, null,
                "auto", "t", picks);
        picks.clear();

        assertEquals(Map.of("write_plan", new Playbook.ModelRef("ollama", "qwen3:8b")), setup.picks());
        assertThrows(UnsupportedOperationException.class, () -> setup.picks().put("x", null));
        assertEquals(Map.of(), new PlaybookRunner.Setup(pinned, "abcdefabcdef", tmp.resolve("g"), null, null,
                "auto", "t", null).picks());
        assertEquals(Map.of(), new PlaybookRunner.Setup(pinned, "abcdefabcdef", tmp.resolve("g"), null, null,
                "auto", "t").picks(), "the card 554 shape runs without picks");
    }

    private static void write(Path file, String text) {
        try {
            Files.writeString(file, text);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
