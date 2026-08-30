package dev.spectroscope.core.provider;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Resolves a {@link ReasoningCapability} from the ONE static table
 * ({@code reasoning/capabilities.json} in the core resources). Providers call
 * this before spending a wire field; the server's capability endpoint serves
 * the same records (overlaying live discovery where a provider's API offers
 * it — anthropic, ollama, openrouter). Rows are prefix patterns, first match
 * wins, {@code "*"} is the per-dialect catch-all.
 */
public final class ReasoningCapabilities {

    /** One parsed row: a prefix pattern plus the record it yields. */
    private record Rule(String pattern, ReasoningCapability capability) {}

    private static final Map<String, List<Rule>> TABLE = load();

    private ReasoningCapabilities() {
    }

    /**
     * The static capability record for a (dialect, model) pair.
     *
     * @param dialect the wire dialect — a top-level key of
     *                {@code reasoning/capabilities.json}, which is the table
     *                itself and therefore the only list worth reading
     * @param model   the model id/name as configured; null or blank falls to
     *                the dialect's catch-all row
     * @return the matching record; an unknown dialect answers
     *         {@link ReasoningCapability#none} rather than throwing
     */
    public static ReasoningCapability resolve(String dialect, String model) {
        List<Rule> rules = TABLE.get(dialect);
        if (rules == null) {
            return ReasoningCapability.none("static");
        }
        String name = model == null ? "" : model;
        for (Rule rule : rules) {
            if (rule.pattern().equals("*") || (!name.isEmpty() && name.startsWith(rule.pattern()))) {
                return rule.capability();
            }
        }
        return ReasoningCapability.none("static");
    }

    /** Parses the bundled table once; a malformed resource is a build defect
     *  and fails loudly rather than degrading every capability to none. */
    private static Map<String, List<Rule>> load() {
        try (InputStream in = ReasoningCapabilities.class
                .getResourceAsStream("/reasoning/capabilities.json")) {
            if (in == null) {
                throw new IllegalStateException("reasoning/capabilities.json missing from spectro-core resources");
            }
            JsonNode root = new ObjectMapper().readTree(in);
            Map<String, List<Rule>> table = new LinkedHashMap<>();
            root.path("providers").properties().forEach(entry -> {
                List<Rule> rules = new ArrayList<>();
                for (JsonNode row : entry.getValue().path("rules")) {
                    rules.add(new Rule(row.path("pattern").asText(), fromJson(row)));
                }
                table.put(entry.getKey(), rules);
            });
            return Map.copyOf(table);
        } catch (IOException unreadable) {
            throw new UncheckedIOException("reasoning/capabilities.json unreadable", unreadable);
        }
    }

    /** One JSON row → the record; absent fields take the honest zero. */
    private static ReasoningCapability fromJson(JsonNode row) {
        List<String> efforts = new ArrayList<>();
        row.path("efforts").forEach(effort -> efforts.add(effort.asText()));
        return new ReasoningCapability(
                row.path("control").asText("none"),
                row.path("defaultOn").asBoolean(false),
                row.path("offSwitch").asBoolean(false),
                efforts,
                textOrNull(row, "defaultEffort"),
                textOrNull(row, "offMaxEffort"),
                textOrNull(row, "wire"),
                row.path("source").asText("static"));
    }

    private static String textOrNull(JsonNode row, String field) {
        JsonNode value = row.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }
}
