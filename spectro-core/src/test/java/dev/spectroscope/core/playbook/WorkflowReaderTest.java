package dev.spectroscope.core.playbook;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 506, criterion 1: the shape of a workflow file and what the loader refuses. */
class WorkflowReaderTest {

    static final String REVIEW = """
            {
              "name": "fanout-review",
              "description": "Three reviewers over the diff, one summariser.",
              "steps": [
                { "kind": "prompt", "id": "diff", "template": "Show the diff of {{folder}}." },
                {
                  "kind": "fanout",
                  "id": "review",
                  "agents": [
                    { "role": "explore", "task": "Check correctness: {{previous}}" },
                    { "role": "explore", "task": "Check security: {{previous}}" },
                    { "task": { "en": "Check readability: {{previous}}", "de": "Lesbarkeit: {{previous}}" } }
                  ],
                  "join": { "task": "Summarise: {{results}}" }
                },
                { "kind": "end", "id": "done", "result": "reviewed" }
              ]
            }
            """;

    private static Workflow ok(String json) {
        WorkflowReader.Read read = WorkflowReader.read(json);
        assertEquals(List.of(), read.findings());
        assertNotNull(read.workflow());
        return read.workflow();
    }

    private static List<Finding> refused(String json) {
        WorkflowReader.Read read = WorkflowReader.read(json);
        assertNull(read.workflow(), "the file should be refused: " + read.findings());
        assertFalse(read.findings().isEmpty());
        return read.findings();
    }

    private static boolean has(List<Finding> findings, String path, String part) {
        return findings.stream().anyMatch(f -> f.path().equals(path) && f.message().contains(part));
    }

    @Test
    void aFileReadsIntoItsPromptFanoutAndEndSteps() {
        Workflow w = ok(REVIEW);
        assertEquals("fanout-review", w.name());
        assertEquals("Three reviewers over the diff, one summariser.", w.description());
        assertFalse(w.scenario());
        assertEquals(3, w.steps().size());
        Workflow.Prompt p = (Workflow.Prompt) w.steps().get(0);
        assertEquals("diff", p.id());
        assertEquals("Show the diff of {{folder}}.", p.template().in("en"));
        Workflow.Fanout f = (Workflow.Fanout) w.steps().get(1);
        assertEquals(3, f.agents().size());
        assertEquals("explore", f.agents().get(0).role());
        assertNull(f.agents().get(2).role());
        assertEquals("explore", f.agents().get(2).roleOrDefault());
        assertEquals("Lesbarkeit: {{previous}}", f.agents().get(2).task().in("de"));
        assertEquals("Summarise: {{results}}", f.join().task().in("en"));
        Workflow.End e = (Workflow.End) w.steps().get(2);
        assertEquals("reviewed", e.result());
    }

    @Test
    void aStepThatRepeatsWithoutMaxRoundsIsRefusedWithTheLineThatNamesTheStep() {
        String json = """
                {
                  "name": "loop",
                  "steps": [
                    { "kind": "prompt", "id": "ask", "template": "go" },
                    {
                      "kind": "prompt",
                      "id": "again",
                      "template": "Fix it.",
                      "repeat_until": "DONE"
                    },
                    { "kind": "end" }
                  ]
                }
                """;
        List<Finding> findings = refused(json);
        assertTrue(has(findings, "steps[1]", "line 5"), findings.toString());
        assertTrue(has(findings, "steps[1]", "step \"again\" repeats"), findings.toString());
        assertTrue(has(findings, "steps[1]", "max_rounds"), findings.toString());
    }

    @Test
    void aRepeatingFanoutWithoutMaxRoundsIsRefusedToo() {
        String json = REVIEW.replace("\"join\": { \"task\": \"Summarise: {{results}}\" }",
                "\"join\": { \"task\": \"Summarise: {{results}}\" }, \"repeat_until\": \"LGTM\"");
        List<Finding> findings = refused(json);
        assertTrue(has(findings, "steps[1]", "line 6"), findings.toString());
        assertTrue(has(findings, "steps[1]", "step \"review\" repeats"), findings.toString());
    }

    @Test
    void aRepeatingStepWithMaxRoundsReads() {
        Workflow w = ok(REVIEW.replace("\"template\": \"Show the diff of {{folder}}.\"",
                "\"template\": \"Show the diff of {{folder}}.\", \"repeat_until\": \"diff --git\", \"max_rounds\": 3"));
        Workflow.Prompt p = (Workflow.Prompt) w.steps().get(0);
        assertEquals("diff --git", p.repeatUntil());
        assertEquals(3, p.maxRounds());
    }

    @Test
    void maxRoundsWithoutRepeatAndMaxRoundsAboveTheLimitAreFindings() {
        assertTrue(has(refused(REVIEW.replace("\"id\": \"diff\",", "\"id\": \"diff\", \"max_rounds\": 2,")),
                "steps[0].max_rounds", "repeat_until"));
        String tooMany = REVIEW.replace("\"id\": \"diff\",", "\"id\": \"diff\", \"repeat_until\": \"x\", \"max_rounds\": "
                + (WorkflowReader.MAX_ROUNDS_LIMIT + 1) + ",");
        assertTrue(has(refused(tooMany), "steps[0].max_rounds", "1 to " + WorkflowReader.MAX_ROUNDS_LIMIT));
    }

    @Test
    void unknownFieldsAndKindsAreFindingsAndSplitIsNotAStepKind() {
        assertTrue(has(refused(REVIEW.replace("\"name\": \"fanout-review\",", "\"name\": \"fanout-review\", \"nodes\": [],")),
                "nodes", "unknown field"));
        assertTrue(has(refused(REVIEW.replace("\"kind\": \"prompt\", \"id\": \"diff\", \"template\": \"Show the diff of {{folder}}.\"",
                "\"kind\": \"split\", \"id\": \"diff\"")), "steps[0].kind", "prompt, fanout or end"));
        assertTrue(has(refused(REVIEW.replace("\"result\": \"reviewed\"", "\"result\": \"reviewed\", \"next\": \"x\"")),
                "steps[2].next", "unknown field"));
    }

    @Test
    void theLastStepIsTheOneEndAndNothingFollowsIt() {
        assertTrue(has(refused(REVIEW.replace(",\n    { \"kind\": \"end\", \"id\": \"done\", \"result\": \"reviewed\" }", "")),
                "steps", "the last step must be an end"));
        assertTrue(has(refused(REVIEW.replace("\"result\": \"reviewed\" }", "\"result\": \"reviewed\" }, { \"kind\": \"end\" }")),
                "steps[2]", "only the last step may be an end"));
        assertTrue(has(refused("{ \"name\": \"x\", \"steps\": [] }"), "steps", "at least one step"));
    }

    @Test
    void aFanoutTakesOneToTheBatchWidthOfChildrenThatAreExploreOrWorker() {
        assertTrue(has(refused(REVIEW.replace("\"role\": \"explore\", \"task\": \"Check security", "\"role\": \"research\", \"task\": \"Check security")),
                "steps[1].agents[1].role", "explore or worker"));
        String five = REVIEW.replace("{ \"role\": \"explore\", \"task\": \"Check security: {{previous}}\" },",
                "{ \"task\": \"a\" }, { \"task\": \"b\" }, { \"task\": \"c\" },");
        assertEquals(WorkflowReader.MAX_AGENTS + 1, 5);
        assertTrue(has(refused(five), "steps[1].agents", "1 to " + WorkflowReader.MAX_AGENTS));
        assertTrue(has(refused(REVIEW.replace("\"task\": \"Check security: {{previous}}\"", "\"task\": \"  \"")),
                "steps[1].agents[1].task", "empty"));
    }

    @Test
    void aPlaceholderTheRunnerDoesNotFillIsAFindingAndResultsBelongToTheJoin() {
        assertTrue(has(refused(REVIEW.replace("{{folder}}", "{{diff}}")), "steps[0].template", "{{diff}}"));
        assertTrue(has(refused(REVIEW.replace("Check correctness: {{previous}}", "Check {{results}}")),
                "steps[1].agents[0].task", "{{results}}"));
        assertTrue(has(refused(REVIEW.replace("Lesbarkeit: {{previous}}", "Lesbarkeit: {{vorher}}")),
                "steps[1].agents[2].task", "{{vorher}}"));
    }

    @Test
    void aFileOverTheCapIsRefusedBeforeItIsParsed() {
        String big = REVIEW.replace("one summariser.", "one summariser." + "x".repeat(WorkflowReader.MAX_FILE_BYTES));
        List<Finding> findings = refused(big);
        assertEquals(1, findings.size());
        assertTrue(findings.get(0).message().contains(WorkflowReader.MAX_FILE_BYTES + " bytes"), findings.toString());
    }

    @Test
    void malformedJsonIsOneFindingAtTheRoot() {
        List<Finding> findings = refused("{ not json");
        assertEquals(1, findings.size());
        assertEquals("", findings.get(0).path());
    }

    @Test
    void aStepWithoutAnIdIsNamedByItsKindAndPosition() {
        Workflow w = ok(REVIEW.replace("\"kind\": \"end\", \"id\": \"done\",", "\"kind\": \"end\","));
        assertEquals("end-3", w.steps().get(2).id());
        assertFalse(w.steps().get(2).idGiven());
        assertTrue(w.steps().get(0).idGiven());
    }

    @Test
    void twoStepsWithOneIdAreAFinding() {
        assertTrue(has(refused(REVIEW.replace("\"id\": \"review\"", "\"id\": \"diff\"")), "steps[1].id", "\"diff\""));
    }

    // ---- Fix round 2 -------------------------------------------------------------------------

    /** A fan-out of {@code agents} children, a summariser, repeating {@code rounds} times. */
    private static String fanout(String id, int agents, int rounds) {
        StringBuilder a = new StringBuilder();
        for (int i = 0; i < agents; i++) {
            a.append(i == 0 ? "" : ", ").append("{ \"task\": \"look ").append(i).append("\" }");
        }
        String repeat = rounds > 1 ? ", \"repeat_until\": \"DONE\", \"max_rounds\": " + rounds : "";
        return "{ \"kind\": \"fanout\", \"id\": \"" + id + "\", \"agents\": [ " + a
                + " ], \"join\": { \"task\": \"Join {{results}}\" }" + repeat + " }";
    }

    private static String file(List<String> steps) {
        return "{ \"name\": \"big\", \"steps\": [\n" + String.join(",\n", steps) + ",\n{ \"kind\": \"end\" } ] }";
    }

    @Test
    void aRunThatWouldStartMoreChildRunsThanTheCeilingIsRefusedAtTheStepThatCrossesIt() {
        // Four rounds of the widest fan-out (four children and a summariser) is the ceiling.
        int perRound = WorkflowReader.MAX_AGENTS + 1;
        int rounds = WorkflowReader.MAX_CHILD_RUNS / perRound;
        ok(file(List.of(fanout("a", WorkflowReader.MAX_AGENTS, rounds))));
        List<Finding> findings = refused(file(List.of(fanout("a", WorkflowReader.MAX_AGENTS, rounds),
                fanout("b", 1, 1).replace(", \"join\": { \"task\": \"Join {{results}}\" }", ""),
                fanout("c", 2, 1))));
        assertTrue(has(findings, "steps[1]", "child runs"), findings.toString());
        assertTrue(has(findings, "steps[1]", String.valueOf(WorkflowReader.MAX_CHILD_RUNS)), findings.toString());
        assertEquals(1, findings.size(), "one finding, at the step that passes the ceiling: " + findings);
    }

    @Test
    void aRepeatingFanoutCountsEveryRoundAndItsSummariser() {
        // 3 children and a summariser, 10 rounds: 40 child runs from one step.
        List<Finding> findings = refused(file(List.of(fanout("wide", 3, WorkflowReader.MAX_ROUNDS_LIMIT))));
        assertTrue(has(findings, "steps[0]", "40 child runs"), findings.toString());
    }

    @Test
    void aRunThatWouldRunMoreStepsThanTheCeilingIsRefusedAtTheStepThatCrossesIt() {
        List<String> steps = new java.util.ArrayList<>();
        for (int i = 0; i <= WorkflowReader.MAX_STEP_RUNS + 2; i++) {
            steps.add("{ \"kind\": \"prompt\", \"id\": \"p" + i + "\", \"template\": \"say " + i + "\" }");
        }
        ok(file(steps.subList(0, WorkflowReader.MAX_STEP_RUNS)));
        List<Finding> findings = refused(file(steps));
        assertTrue(has(findings, "steps[" + WorkflowReader.MAX_STEP_RUNS + "]", "step runs"), findings.toString());
        assertEquals(1, findings.size(), "one finding, at the step that passes the ceiling: " + findings);
    }

    @Test
    void aRepeatingPromptCountsEveryRoundAsAStepRun() {
        List<String> steps = new java.util.ArrayList<>();
        steps.add("{ \"kind\": \"prompt\", \"id\": \"loop\", \"template\": \"again\", \"repeat_until\": \"OK\", \"max_rounds\": "
                + WorkflowReader.MAX_ROUNDS_LIMIT + " }");
        for (int i = 0; i < WorkflowReader.MAX_STEP_RUNS - WorkflowReader.MAX_ROUNDS_LIMIT; i++) {
            steps.add("{ \"kind\": \"prompt\", \"id\": \"p" + i + "\", \"template\": \"say " + i + "\" }");
        }
        ok(file(steps));
        steps.add("{ \"kind\": \"prompt\", \"id\": \"one-more\", \"template\": \"say it\" }");
        assertTrue(has(refused(file(steps)), "steps[" + (steps.size() - 1) + "]", "step runs"));
    }

    @Test
    void aDuplicateKeyIsRefusedWithItsLineSoTheTreeAndTheLinesCannotDisagree() {
        String json = """
                {
                  "name": "twice",
                  "steps": [
                    { "kind": "prompt", "id": "first", "template": "a", "repeat_until": "x" },
                    { "kind": "end" }
                  ],
                  "steps": [
                    { "kind": "end" }
                  ]
                }
                """;
        List<Finding> findings = refused(json);
        assertEquals(1, findings.size(), findings.toString());
        assertEquals("", findings.get(0).path());
        assertTrue(findings.get(0).message().startsWith("line 7: "), findings.toString());
        assertTrue(findings.get(0).message().contains("\"steps\""), findings.toString());
        // Inside a step too: the last "kind" would win in the tree.
        List<Finding> inStep = refused("{ \"name\": \"n\", \"steps\": [ { \"kind\": \"prompt\", \"kind\": \"end\" } ] }");
        assertTrue(inStep.get(0).message().contains("\"kind\""), inStep.toString());
    }
}
