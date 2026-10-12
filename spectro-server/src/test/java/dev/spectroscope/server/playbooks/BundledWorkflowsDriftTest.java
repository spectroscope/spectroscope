package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.playbook.Workflow;
import dev.spectroscope.core.playbook.WorkflowReader;
import dev.spectroscope.core.playbook.WorkflowWriter;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 506, criterion 4: the bundled pack {@code spectro} ships two fan-out
 * workflows. The list in {@code playbook.json} {@code contents.workflows} is
 * held to the files of the {@code workflows/} folder, so a file added on one
 * side alone goes red, and each file reads clean, stays under 4 kB, has its
 * provenance line and is stored the way the writer prints it.
 */
class BundledWorkflowsDriftTest {

    private static final String BUNDLE = SpectroPlaybookTest.BUNDLE;
    /** The size the card allows one shipped workflow file. */
    private static final int MAX_SHIPPED_BYTES = 4_096;

    private static Map<String, Resource> folder() throws IOException {
        return SpectroPlaybookTest.filesUnder(BUNDLE + "workflows/");
    }

    private static JsonNode playbook() throws IOException {
        return new ObjectMapper().readTree(new ClassPathResource(BUNDLE + "playbook.json")
                .getContentAsString(StandardCharsets.UTF_8));
    }

    @Test
    void theListedWorkflowsAreExactlyTheFilesOfTheFolder() throws IOException {
        List<String> listed = new ArrayList<>();
        playbook().path("contents").path("workflows").forEach(w -> listed.add(w.asText()));
        List<String> files = folder().keySet().stream().map(name -> "workflows/" + name).sorted().toList();
        assertEquals(files, listed, "contents.workflows of the bundled playbook and its workflows/ folder differ");
        assertEquals(List.of("workflows/fanout-research.json", "workflows/fanout-review.json"), files);
    }

    @Test
    void eachShippedWorkflowReadsCleanIsAFanoutOfThreeWithASummariserAndIsSmall() throws IOException {
        for (Map.Entry<String, Resource> f : folder().entrySet()) {
            byte[] bytes = f.getValue().getContentAsByteArray();
            assertTrue(bytes.length < MAX_SHIPPED_BYTES, f.getKey() + " has " + bytes.length + " bytes");
            WorkflowReader.Read read = WorkflowReader.read(bytes);
            assertEquals(List.of(), read.findings(), f.getKey());
            Workflow w = read.workflow();
            assertEquals(f.getKey(), w.name() + ".json");
            List<Workflow.Fanout> fanouts = w.steps().stream().filter(Workflow.Fanout.class::isInstance)
                    .map(Workflow.Fanout.class::cast).toList();
            assertEquals(1, fanouts.size(), f.getKey());
            assertEquals(3, fanouts.get(0).agents().size(), f.getKey());
            assertTrue(fanouts.get(0).agents().stream().allMatch(a -> "explore".equals(a.roleOrDefault())), f.getKey());
            assertTrue(fanouts.get(0).join() != null && fanouts.get(0).join().task().in("en").contains("{{results}}"),
                    f.getKey());
            assertEquals(new String(bytes, StandardCharsets.UTF_8), WorkflowWriter.write(w),
                    f.getKey() + " is not stored in the canonical form");
        }
    }

    @Test
    void theReviewReadsTheDiffAndTheResearchTheQuestion() throws IOException {
        Workflow review = WorkflowReader.read(folder().get("fanout-review.json").getContentAsByteArray()).workflow();
        assertTrue(((Workflow.Prompt) review.steps().get(0)).template().in("en").contains("git diff"));
        Workflow.Fanout reviewers = (Workflow.Fanout) review.steps().get(1);
        assertTrue(reviewers.agents().stream().allMatch(a -> a.task().in("en").contains("{{previous}}")));
        Workflow research = WorkflowReader.read(folder().get("fanout-research.json").getContentAsByteArray()).workflow();
        Workflow.Fanout explorers = (Workflow.Fanout) research.steps().get(0);
        assertTrue(explorers.agents().stream().allMatch(a -> a.task().in("en").contains("{{input}}")));
    }

    @Test
    void eachShippedWorkflowHasItsProvenanceLine() throws IOException {
        String provenance = new ClassPathResource(BUNDLE + "PROVENANCE.md").getContentAsString(StandardCharsets.UTF_8);
        for (String name : folder().keySet()) {
            assertTrue(provenance.contains("- `workflows/" + name + "`"), "PROVENANCE.md has no line for " + name);
        }
    }

    /** Every text of the step a template can carry: prompt templates, child tasks and join tasks. */
    private static List<String> texts(Workflow w) {
        List<String> out = new ArrayList<>();
        for (Workflow.Step step : w.steps()) {
            if (step instanceof Workflow.Prompt p) {
                out.addAll(p.template().all());
            } else if (step instanceof Workflow.Fanout f) {
                f.agents().forEach(a -> out.addAll(a.task().all()));
                if (f.join() != null) {
                    out.addAll(f.join().task().all());
                }
            }
        }
        return out;
    }

    @Test
    void theTextTypedBesideRunReachesEveryChildAndEverySummariserOfAWorkflowThatNamesIt() throws IOException {
        // Fix round 2: the note of fanout-review named {{input}} only in the step
        // that prints the diff, and no reviewer ever saw it.
        int naming = 0;
        for (Map.Entry<String, Resource> f : folder().entrySet()) {
            Workflow w = WorkflowReader.read(f.getValue().getContentAsByteArray()).workflow();
            if (texts(w).stream().noneMatch(t -> t.contains("{{input}}"))) {
                continue;
            }
            naming++;
            for (Workflow.Step step : w.steps()) {
                if (step instanceof Workflow.Fanout fan) {
                    for (Workflow.Agent a : fan.agents()) {
                        assertTrue(a.task().all().stream().allMatch(t -> t.contains("{{input}}")),
                                f.getKey() + ": a child of " + fan.id() + " never sees the text typed beside Run");
                    }
                    assertTrue(fan.join().task().all().stream().allMatch(t -> t.contains("{{input}}")),
                            f.getKey() + ": the summariser of " + fan.id() + " never sees the text typed beside Run");
                }
            }
        }
        assertEquals(folder().size(), naming, "both shipped workflows take a question or a note");
    }

    @Test
    void theStepThatPrintsTheDiffAsksForTheDiffAloneAndCarriesNoNote() throws IOException {
        Workflow review = WorkflowReader.read(folder().get("fanout-review.json").getContentAsByteArray()).workflow();
        Workflow.Prompt diff = (Workflow.Prompt) review.steps().get(0);
        assertTrue(diff.template().in("en").contains("nothing else"), diff.template().in("en"));
        assertTrue(diff.template().all().stream().noneMatch(t -> t.contains("{{input}}")),
                "a note in the diff step goes to the main agent, which is told to answer with the diff alone");
    }
}
