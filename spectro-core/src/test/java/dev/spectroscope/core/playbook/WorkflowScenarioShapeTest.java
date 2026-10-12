package dev.spectroscope.core.playbook;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 506, criterion 1: a file in the scenario DSL's {@code fanout:} shape
 * converts without loss. The file below is a hand-written sample in that
 * shape, modelled on the {@code fanout} step of {@code codereview} in
 * {@code spectro-web/src/scenario/registry.ts} and extended with what the
 * registry does not have: a role, a join, {@code repeat_until} and
 * {@code max_rounds}. The real registry steps are pinned by
 * {@link WorkflowRegistryFanoutsTest}.
 */
class WorkflowScenarioShapeTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    static final String SCENARIO = """
            {
              "name": "codereview",
              "description": "Three lenses in parallel, then a verdict table.",
              "steps": [
                { "prompt": { "en": "Write the target first.", "de": "Schreibe zuerst das Ziel." }, "id": "target" },
                {
                  "fanout": {
                    "label": "review",
                    "tool": "review",
                    "agents": [
                      {
                        "id": "correctness",
                        "task": { "en": "Check correctness", "de": "Prüfe Korrektheit" },
                        "steps": [ { "read": "review_target.py" }, { "say": "fine" } ]
                      },
                      { "id": "security", "task": { "en": "Check security", "de": "Prüfe Sicherheit" }, "steps": [] },
                      { "id": "readability", "role": "worker", "task": "Check readability" }
                    ],
                    "join": { "task": "Give a verdict table over {{results}}" }
                  },
                  "repeat_until": "verdict",
                  "max_rounds": 2
                },
                { "end": { "result": "reviewed" } }
              ]
            }
            """;

    /** The same file in the canonical shape, as the writer prints it. */
    static final String CANONICAL = """
            {
              "name": "codereview",
              "description": "Three lenses in parallel, then a verdict table.",
              "steps": [
                {
                  "kind": "prompt",
                  "id": "target",
                  "template": {
                    "en": "Write the target first.",
                    "de": "Schreibe zuerst das Ziel."
                  }
                },
                {
                  "kind": "fanout",
                  "label": "review",
                  "tool": "review",
                  "agents": [
                    {
                      "id": "correctness",
                      "task": {
                        "en": "Check correctness",
                        "de": "Prüfe Korrektheit"
                      },
                      "steps": [
                        {
                          "read": "review_target.py"
                        },
                        {
                          "say": "fine"
                        }
                      ]
                    },
                    {
                      "id": "security",
                      "task": {
                        "en": "Check security",
                        "de": "Prüfe Sicherheit"
                      },
                      "steps": []
                    },
                    {
                      "id": "readability",
                      "role": "worker",
                      "task": "Check readability"
                    }
                  ],
                  "join": {
                    "task": "Give a verdict table over {{results}}"
                  },
                  "repeat_until": "verdict",
                  "max_rounds": 2
                },
                {
                  "kind": "end",
                  "result": "reviewed"
                }
              ]
            }
            """;

    private static JsonNode tree(String json) throws Exception {
        return JSON.readTree(json);
    }

    @Test
    void aScenarioShapedFileReadsAndConvertsBackWithoutLoss() throws Exception {
        WorkflowReader.Read read = WorkflowReader.read(SCENARIO);
        assertEquals(List.of(), read.findings());
        Workflow w = read.workflow();
        assertTrue(w.scenario());
        Workflow.Fanout f = (Workflow.Fanout) w.steps().get(1);
        assertEquals("review", f.label());
        assertEquals("review", f.tool());
        assertEquals("correctness", f.agents().get(0).id());
        assertEquals(2, f.agents().get(0).steps().size());
        assertEquals(2, f.maxRounds());
        assertEquals(tree(SCENARIO), tree(WorkflowWriter.toScenarioShape(w)));
    }

    @Test
    void theConversionToTheCanonicalShapeIsPinned() {
        assertEquals(CANONICAL, WorkflowWriter.write(WorkflowReader.read(SCENARIO).workflow()));
    }

    @Test
    void theCanonicalShapeReadsBackToTheSameWorkflowAndTheSameScenario() throws Exception {
        WorkflowReader.Read read = WorkflowReader.read(CANONICAL);
        assertEquals(List.of(), read.findings());
        assertEquals(CANONICAL, WorkflowWriter.write(read.workflow()));
        assertEquals(tree(SCENARIO), tree(WorkflowWriter.toScenarioShape(read.workflow())));
    }

    @Test
    void aScenarioStepWithTwoKindKeysIsAFinding() {
        WorkflowReader.Read read = WorkflowReader.read(SCENARIO.replace("{ \"end\": { \"result\": \"reviewed\" } }",
                "{ \"end\": {}, \"prompt\": \"x\" }"));
        assertTrue(read.findings().stream().anyMatch(f -> f.path().equals("steps[2]")
                && f.message().contains("exactly one of kind, prompt, fanout or end")), read.findings().toString());
    }
}
