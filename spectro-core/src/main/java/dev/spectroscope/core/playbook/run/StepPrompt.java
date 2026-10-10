package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.playbook.AgentFile;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.subagents.SubagentManager;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** The two texts a step runs on: a short record a person reads, and the model's text with skills and templates. */
public final class StepPrompt {

    /**
     * @param record what the session file shows
     * @param model  what the model receives
     */
    public record Prompt(String record, String model) {
    }

    private StepPrompt() {
    }

    /**
     * @param pinned the pinned playbook
     * @param step   the step
     * @param found  document id to the workspace relative path found so far
     * @return both texts
     */
    public static Prompt of(PinnedPlaybook pinned, Playbook.Step step, Map<String, String> found) {
        Playbook p = pinned.playbook();
        List<String> reads = new ArrayList<>();
        for (String id : step.consumes()) {
            Playbook.DocumentType d = p.documents().get(id);
            reads.add(d.name() + " at " + found.getOrDefault(id, d.location()));
        }
        List<String> writes = new ArrayList<>();
        for (String id : step.produces()) {
            Playbook.DocumentType d = p.documents().get(id);
            writes.add(d.name() + " at " + d.location()
                    + (d.sections().isEmpty() ? "" : " with the sections " + String.join(", ", d.sections())));
        }
        List<String> done = CheckText.doneWhen(p, step);
        String record = "Playbook " + p.name() + ", step " + step.name() + " (" + step.id() + ").\n"
                + "Goal: " + (step.goal() == null || step.goal().isBlank() ? "none stated" : step.goal()) + "\n"
                + "Read: " + (reads.isEmpty() ? "nothing" : String.join("; ", reads)) + ".\n"
                + "Write: " + (writes.isEmpty() ? "nothing" : String.join("; ", writes)) + ".\n"
                + "Done when: " + (done.isEmpty() ? "the step ends" : String.join("; ", done)) + ".";
        StringBuilder model = new StringBuilder(record);
        for (String name : step.skills()) {
            SkillBody body = pinned.skills().get(name);
            if (body != null) {
                model.append("\n\n## Skill ").append(name).append("\n\n").append(body.text());
            }
        }
        for (String id : step.produces()) {
            String template = pinned.templates().get(id);
            if (template != null) {
                model.append("\n\n## Template for ").append(p.documents().get(id).name()).append("\n\n").append(template);
            }
        }
        return new Prompt(record, model.toString());
    }

    /**
     * The text a child of an {@code agent:<name>} role runs on: the agent
     * file's preamble, the report instruction and the step's model text, in
     * the composition the static role tools use. The role text comes from
     * the file only; the step contributes the task.
     *
     * @param agent the resolved agent file
     * @param task  the step's model text
     * @return the composed text
     */
    public static String forAgent(AgentFile agent, String task) {
        return SubagentManager.roleTask(agent.preamble(), task);
    }
}
