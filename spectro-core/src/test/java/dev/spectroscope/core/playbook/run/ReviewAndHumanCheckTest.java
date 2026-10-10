package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.provider.SwitchableProvider;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ReviewAndHumanCheckTest {

    @Test
    void theLastLineWinsThenTheLatestWholeWord() {
        List<String> labels = List.of("pass", "fail");
        assertEquals("fail", ReviewCheck.labelOf("It would pass the build.\n\nFAIL.", labels));
        assertEquals("pass", ReviewCheck.labelOf("I first thought fail, but on reading again it is a pass overall", labels));
        assertNull(ReviewCheck.labelOf("passing and failing are both possible", labels), "no whole word");
    }

    @Test
    void theReviewTaskNamesTheDocumentsAndTheLabels() {
        Map<String, Path> docs = new LinkedHashMap<>();
        docs.put("spec", Path.of("/ws/spec.md"));
        docs.put("plan", null);
        assertEquals("""
                You review documents for a playbook step. Read them, then judge.
                - spec: /ws/spec.md
                - plan: not written yet
                Question: Does the plan cover the spec?
                Give your reasons. End with one line that holds exactly one of these words: pass, fail.""",
                ReviewCheck.task("Does the plan cover the spec?", List.of("pass", "fail"), docs));
    }

    @Test
    void aReviewRunsAReadOnlyChildOnTheNamedModel() {
        StepChildOnGraphTest.OneTurn judge = new StepChildOnGraphTest.OneTurn("judge-model", "Looks complete.\npass");
        List<RunEvent> events = new ArrayList<>();
        CheckResult r = ReviewCheck.run("review it", List.of("pass", "fail"), new SwitchableProvider(judge, "anthropic"),
                StepChildOnGraphTest.manager(new StepChildOnGraphTest.OneTurn("chat", "unused")), events::add,
                new CancelSignal(), "playbook:review_task");
        assertEquals("pass", r.label());
        assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.RunStart s
                && s.agentId().startsWith("explore-") && "anthropic".equals(s.provider())));
    }

    @Test
    void aReviewerRunsUnderTheStricterPrivacyOfTheStepsThatWroteWhatItReads() {
        Playbook p = playbook(
                step("write_spec", "cheap", List.of("spec")),
                step("implement", "private", List.of("code", "notes")),
                step("write_plan", null, List.of("plan")));
        assertEquals("cheap", ReviewCheck.privacy(p, List.of("spec", "plan")));
        assertEquals("private", ReviewCheck.privacy(p, List.of("spec", "code")), "one private writer is enough");
        assertEquals("private", ReviewCheck.privacy(p, List.of("notes")));
        assertEquals("cheap", ReviewCheck.privacy(p, List.of()), "nothing read, nothing to protect");
        assertEquals("cheap", ReviewCheck.privacy(p, List.of("unknown")));
    }

    @Test
    void aHumanCheckAsksWithTheLabelsAndRecordsTheAnswer() {
        List<RunEvent> events = new ArrayList<>();
        Asker asker = question -> new Asker.Answer(List.of("yes"));
        HumanCheck.Asked a = HumanCheck.ask("pb-r-1", "Does the spec say what you want built?",
                List.of("yes", "no"), asker, events::add);
        assertEquals("yes", a.label());
        RunEvent.QuestionAsked asked = (RunEvent.QuestionAsked) events.get(0);
        assertEquals("main", asked.agentId());
        assertEquals(List.of("yes", "no"), asked.questions().get(0).options().stream()
                .map(RunEvent.QuestionOption::label).toList());
        RunEvent.QuestionAnswered answered = (RunEvent.QuestionAnswered) events.get(1);
        assertEquals(List.of("yes"), answered.answers());
    }

    @Test
    void nobodyAndAnAnswerOutsideTheLabelsGiveNoLabel() {
        List<RunEvent> events = new ArrayList<>();
        assertNull(HumanCheck.ask("pb-r-2", "q", List.of("yes", "no"), null, events::add).label());
        assertTrue(((RunEvent.QuestionAnswered) events.get(1)).cancelled());
        assertNull(HumanCheck.ask("pb-r-3", "q", List.of("yes", "no"),
                question -> new Asker.Answer(List.of("maybe later")), e -> { }).label());
    }

    private static Playbook.Step step(String id, String privacy, List<String> produces) {
        return new Playbook.Step(id, id, "goal", "child", "worker", List.of(), "fast", privacy, "inherit",
                List.of(), produces, false);
    }

    private static Playbook playbook(Playbook.Node... nodes) {
        return new Playbook(1, "pb", "pb", "", Map.of(), Map.of(), Map.of(), Map.of(), nodes[0].id(),
                List.of(nodes), List.of(), new Playbook.Contents(List.of(), List.of(), List.of(), List.of(), List.of()));
    }
}
