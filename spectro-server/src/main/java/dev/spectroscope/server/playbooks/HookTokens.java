package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import dev.spectroscope.core.graph.Redaction;
import dev.spectroscope.core.playbook.Finding;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * The credential shapes of the wire redaction, asked of every text in a hooks file (card 538): each
 * string value, the command and the matcher among them, and each field name. Export, ZIP import and
 * the install preview refuse a hook that carries one. A hit names the line, the field and the rule,
 * never the value. Only the shapes the redaction knows are found; a password after a flag or in a
 * {@code key=value} pair is not one of them.
 */
final class HookTokens {

    /** The hooks file every check asks. */
    static final String HOOKS_FILE = "hooks/hooks.json";

    private static final JsonFactory JSON = new JsonFactory();
    /** The fields a hit names by name; any other field is "a field", so a name is never echoed. */
    private static final java.util.Set<String> KNOWN_FIELDS = java.util.Set.of("event", "matcher", "command",
            "timeoutSeconds");

    private HookTokens() {
    }

    /**
     * One command with a credential shape.
     *
     * @param entry the index of the hook entry in the top array, or -1 when the file is no array
     * @param line  the line of the value, counted from 1
     * @param field the field the value belongs to when it is one of the four, "field" for any other,
     *              "field name" when the name itself fired, and "line" for a file that is no JSON
     * @param rule  the redaction rule that fired
     */
    record Hit(int entry, int line, String field, String rule) {}

    /**
     * Every string value and field name of the file at any depth that a redaction rule fires on. A
     * file that is not valid JSON is searched line by line instead, so a broken file cannot hide a key.
     *
     * @param text the hooks file
     * @return the hits in file order
     */
    static List<Hit> scan(String text) {
        List<Hit> out = new ArrayList<>();
        try (JsonParser parser = JSON.createParser(text)) {
            int depth = 0;
            int entry = -1;
            JsonToken token;
            while ((token = parser.nextToken()) != null) {
                if (token == JsonToken.START_OBJECT || token == JsonToken.START_ARRAY) {
                    depth++;
                    if (token == JsonToken.START_OBJECT && depth == 2) {
                        entry++;
                    }
                } else if (token == JsonToken.END_OBJECT || token == JsonToken.END_ARRAY) {
                    depth--;
                } else if (token == JsonToken.FIELD_NAME || token == JsonToken.VALUE_STRING) {
                    String rule = Redaction.firstRule(parser.getText());
                    if (rule != null) {
                        String name = parser.currentName();
                        String field = token == JsonToken.FIELD_NAME ? "field name"
                                : name != null && KNOWN_FIELDS.contains(name) ? name : "field";
                        out.add(new Hit(depth >= 2 ? entry : -1, parser.currentTokenLocation().getLineNr(), field, rule));
                    }
                }
            }
            return out;
        } catch (IOException notJson) {
            List<Hit> lines = new ArrayList<>();
            String[] split = text.split("\n", -1);
            for (int i = 0; i < split.length; i++) {
                String rule = Redaction.firstRule(split[i]);
                if (rule != null) {
                    lines.add(new Hit(-1, i + 1, "line", rule));
                }
            }
            return lines;
        }
    }

    /** The findings of a scan of {@code rel}: path {@code <rel>:<line>}, the rule in the message. */
    static List<Finding> findings(String rel, String text) {
        return scan(text).stream()
                .map(hit -> new Finding(rel + ":" + hit.line(), message(hit)))
                .toList();
    }

    /** What a hit says: the line, the field and the rule, never the value. */
    static String message(Hit hit) {
        String what = switch (hit.field()) {
            case "line" -> "a line of the hooks file";
            case "field name" -> "a field name in the hooks file";
            case "field" -> "a value in a hook";
            case "command" -> "a hook command";
            default -> "the " + hit.field() + " of a hook";
        };
        return "line " + hit.line() + ": " + what + " matches the credential pattern " + hit.rule();
    }
}
