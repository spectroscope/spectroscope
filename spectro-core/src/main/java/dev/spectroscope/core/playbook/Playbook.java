package dev.spectroscope.core.playbook;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.Map;

/**
 * A playbook as read from {@code playbook.json}, schema version 1: model
 * choices, document types, checks, variables, and the graph of steps,
 * decisions and ends joined by arrows. Built by {@link PlaybookReader}.
 *
 * <p>A node's {@code kind()} is a method, not a record component, so it carries
 * {@code @JsonProperty}: without it the load route's JSON names no kind and
 * the web cannot tell a step from a decision.
 */
public record Playbook(int schemaVersion, String id, String name, String description,
        Map<String, ModelChoice> models, Map<String, DocumentType> documents, Map<String, Check> checks,
        Map<String, String> vars, String start, List<Node> nodes, List<Arrow> arrows, Contents contents) {

    public record ModelChoice(ModelRef primary, List<ModelRef> fallbacks) {}

    public record ModelRef(String provider, String model) {}

    public record DocumentType(String name, String purpose, String location, String template, List<String> sections) {}

    public record Check(String kind, List<String> documents, List<String> forbid, String run, String model,
            List<String> reads, String ask, List<String> labels) {}

    public sealed interface Node permits Step, Decision, End {
        String id();

        String kind();
    }

    public record Step(String id, String name, String goal, String performer, String role, List<String> skills,
            String model, String privacy, String permission, List<String> consumes, List<String> produces,
            boolean nod) implements Node {
        @JsonProperty("kind")
        public String kind() {
            return "step";
        }
    }

    public record Decision(String id, String name, String check, List<String> outcomes, Integer maxRounds)
            implements Node {
        @JsonProperty("kind")
        public String kind() {
            return "decision";
        }
    }

    public record End(String id, String result) implements Node {
        @JsonProperty("kind")
        public String kind() {
            return "end";
        }
    }

    public record Arrow(String from, String to, String on) {}

    public record Contents(List<String> skills, List<String> agents, List<String> hooks, List<String> commands,
            List<String> workflows) {}
}
