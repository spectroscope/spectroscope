package dev.spectroscope.core.playbook;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.Iterator;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * Card 506, criterion 1: the JSON schema beside the format says what the
 * loader reads. Every field set, the kinds, the width of a fan-out and the
 * limit of {@code max_rounds} are read off the schema and held against the
 * reader's own sets, so a field added on one side alone goes red.
 */
class WorkflowSchemaTest {

    static JsonNode schema() throws Exception {
        try (InputStream in = WorkflowSchemaTest.class.getClassLoader()
                .getResourceAsStream(WorkflowReader.SCHEMA_RESOURCE)) {
            assertNotNull(in, "no schema at " + WorkflowReader.SCHEMA_RESOURCE);
            return new ObjectMapper().readTree(in);
        }
    }

    private static Set<String> props(JsonNode node) {
        Set<String> out = new TreeSet<>();
        Iterator<String> names = node.path("properties").fieldNames();
        names.forEachRemaining(out::add);
        return out;
    }

    private static Set<String> sorted(Set<String> s) {
        return new TreeSet<>(s);
    }

    @Test
    void theTopLevelFieldsAreTheReadersFields() throws Exception {
        assertEquals(sorted(WorkflowReader.TOP), props(schema()));
    }

    @Test
    void eachStepKindHasTheReadersFields() throws Exception {
        JsonNode defs = schema().path("$defs");
        assertEquals(sorted(WorkflowReader.PROMPT), props(defs.path("prompt")));
        assertEquals(sorted(WorkflowReader.FANOUT), props(defs.path("fanout")));
        assertEquals(sorted(WorkflowReader.END), props(defs.path("end")));
        assertEquals(sorted(WorkflowReader.AGENT), props(defs.path("agent")));
        assertEquals(sorted(WorkflowReader.JOIN), props(defs.path("join")));
    }

    @Test
    void theKindsTheRolesTheWidthAndTheRoundLimitAgree() throws Exception {
        JsonNode defs = schema().path("$defs");
        Set<String> kinds = new TreeSet<>();
        for (String kind : new String[]{"prompt", "fanout", "end"}) {
            kinds.add(defs.path(kind).path("properties").path("kind").path("const").asText());
        }
        assertEquals(sorted(WorkflowReader.KINDS), kinds);
        Set<String> roles = new TreeSet<>();
        defs.path("role").path("enum").forEach(r -> roles.add(r.asText()));
        assertEquals(sorted(WorkflowReader.ROLES), roles);
        assertEquals(WorkflowReader.MAX_AGENTS, defs.path("fanout").path("properties").path("agents").path("maxItems").asInt());
        assertEquals(WorkflowReader.MAX_ROUNDS_LIMIT, defs.path("maxRounds").path("maximum").asInt());
    }
}
