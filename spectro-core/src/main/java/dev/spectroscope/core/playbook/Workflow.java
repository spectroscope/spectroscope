package dev.spectroscope.core.playbook;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/**
 * Card 506: one workflow file of a playbook's {@code workflows/} folder, a JSON
 * step list in the shape of the scenario DSL. {@link WorkflowReader} reads it,
 * {@link WorkflowWriter} writes it back in either of its two shapes, and
 * {@code WorkflowRunner} runs it in the session that started it.
 *
 * @param name        the workflow's name
 * @param description what it does, or null
 * @param steps       the steps in order; the last one is an {@link End}
 * @param scenario    true when the file was written in the scenario DSL's shape, one key per step
 */
public record Workflow(String name, String description, List<Step> steps, boolean scenario) {

    /** A text of the file: a plain string, or an English and a German one. */
    public record Text(String plain, String en, String de) {

        /** @param s a plain string @return the text */
        public static Text of(String s) {
            return new Text(s, null, null);
        }

        /**
         * @param lang {@code de} or anything else for English
         * @return the text in that language; a plain string in every language
         */
        public String in(String lang) {
            if (plain != null) {
                return plain;
            }
            String picked = "de".equals(lang) ? de : en;
            return picked != null ? picked : en != null ? en : de;
        }

        /** @return every text it holds, for the placeholder check */
        public List<String> all() {
            return plain != null ? List.of(plain) : List.of(en, de);
        }
    }

    /** One step. {@code id} is never null after reading: a step without one is named by kind and position. */
    public sealed interface Step permits Prompt, Fanout, End {
        /** @return the step's id */
        String id();

        /** @return true when the file named the id */
        boolean idGiven();
    }

    /**
     * A chat turn with a template.
     *
     * @param id           the step's id
     * @param idGiven      true when the file named it
     * @param template     what the chat turn sends
     * @param repeatUntil  the text the answer must contain before the run goes on, or null
     * @param maxRounds    how often the step runs at most when it repeats, or null
     */
    public record Prompt(String id, boolean idGiven, Text template, String repeatUntil, Integer maxRounds)
            implements Step {
    }

    /**
     * One child of a fan-out.
     *
     * @param id     the name the scenario gave it, or null; the run names children itself
     * @param role   {@code explore} or {@code worker}, or null for explore
     * @param task   the task template
     * @param steps  the recorded steps of a scenario child, kept and never run, or null
     */
    public record Agent(String id, String role, Text task, JsonNode steps) {
        /** @return the role the child runs as */
        public String roleOrDefault() {
            return role == null ? "explore" : role;
        }
    }

    /**
     * The summariser of a fan-out.
     *
     * @param role {@code explore} or {@code worker}, or null for explore
     * @param task the task template; {@code {{results}}} is the children's joined results
     */
    public record Join(String role, Text task) {
        /** @return the role the summariser runs as */
        public String roleOrDefault() {
            return role == null ? "explore" : role;
        }
    }

    /**
     * Several children in the background and one summariser.
     *
     * @param id          the step's id
     * @param idGiven     true when the file named it
     * @param label       the scenario's label, or null
     * @param tool        the scenario's tool name, kept and never called, or null
     * @param agents      the children
     * @param join        the summariser, or null when the joined results are the step's answer
     * @param repeatUntil the text the answer must contain before the run goes on, or null
     * @param maxRounds   how often the step runs at most when it repeats, or null
     */
    public record Fanout(String id, boolean idGiven, String label, String tool, List<Agent> agents, Join join,
                         String repeatUntil, Integer maxRounds) implements Step {
    }

    /**
     * The run's end.
     *
     * @param id      the step's id
     * @param idGiven true when the file named it
     * @param result  the label the run ends with, or null
     */
    public record End(String id, boolean idGiven, String result) implements Step {
    }

    /**
     * Card 506 fix round 2: where this workflow starts a child that runs as {@code worker}, which
     * can write. The playbook module does not run such a workflow until the start sheet for it is
     * decided.
     *
     * @return {@code <step id>.agents[i]} and {@code <step id>.join}, in file order; empty when none
     */
    public List<String> workerRoles() {
        List<String> out = new java.util.ArrayList<>();
        for (Step step : steps) {
            if (step instanceof Fanout f) {
                for (int i = 0; i < f.agents().size(); i++) {
                    if ("worker".equals(f.agents().get(i).roleOrDefault())) {
                        out.add(f.id() + ".agents[" + i + "]");
                    }
                }
                if (f.join() != null && "worker".equals(f.join().roleOrDefault())) {
                    out.add(f.id() + ".join");
                }
            }
        }
        return List.copyOf(out);
    }
}
