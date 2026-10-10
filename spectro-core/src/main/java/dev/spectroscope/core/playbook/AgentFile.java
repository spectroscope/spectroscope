package dev.spectroscope.core.playbook;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/**
 * One agent file of a playbook ({@code agents/<name>.md}): a flat frontmatter
 * of {@code key: value} lines and a body that is the agent's preamble. The
 * skill parser cannot serve here, because it returns neither {@code type} nor
 * {@code skill} and it accepts block scalars, which an agent file does not need.
 *
 * <p>The reader names every problem with a path a person can go and look at
 * ({@code agents/reviewer.md#type}). A refused field makes the agent null;
 * every other finding leaves the agent readable, so the whole list can be shown
 * at once. The belt follows the type and the model follows the step, so a file
 * cannot set either.
 *
 * @param name        equals the file stem
 * @param description one line for the confirmation
 * @param type        one of {@link #TYPES}; the value as written, checked by a finding
 * @param skill       an installed or to be installed skill name, or null
 * @param preamble    the body after the frontmatter
 */
public record AgentFile(String name, String description, String type, String skill, String preamble) {

    /**
     * The result of reading one file.
     *
     * @param agent    the agent, or null when the file cannot be read as one
     * @param findings every problem found, in file order
     */
    public record Read(AgentFile agent, List<Finding> findings) {}

    /** The fields an agent file may carry. */
    public static final Set<String> FIELDS = Set.of("name", "description", "type", "skill");

    /** The child types a step can run. */
    public static final Set<String> TYPES = Set.of("explore", "worker", "research");

    private static final Set<String> SET_BY_OTHERS = Set.of("belt", "model", "permission", "tools");

    private static final String SET_BY_OTHERS_SENTENCE =
            "the belt follows the type and the model follows the step; a playbook cannot set them";

    /**
     * Reads one agent file.
     *
     * @param raw  the file text
     * @param path the playbook relative path, used as the finding prefix, for example {@code agents/reviewer.md}
     * @return the agent and the findings
     */
    public static Read read(String raw, String path) {
        List<Finding> findings = new ArrayList<>();
        String[] lines = raw.split("\n", -1);
        if (lines.length == 0 || !lines[0].stripTrailing().equals("---")) {
            return fail(path, "the file must start with a --- frontmatter block");
        }
        int close = -1;
        for (int i = 1; i < lines.length; i++) {
            if (lines[i].stripTrailing().equals("---")) {
                close = i;
                break;
            }
        }
        if (close < 0) {
            return fail(path, "the frontmatter block is not closed by ---");
        }
        String name = null;
        String description = null;
        String type = null;
        String skill = null;
        boolean refused = false;
        for (int i = 1; i < close; i++) {
            String line = lines[i].stripTrailing();
            if (line.isBlank()) {
                continue;
            }
            int colon = line.indexOf(':');
            if (colon <= 0) {
                findings.add(new Finding(path, "not a key: value line: " + line.strip()));
                continue;
            }
            String field = line.substring(0, colon).strip();
            String at = path + "#" + field;
            String value = unquote(line.substring(colon + 1).strip());
            if (PlaybookReader.REFUSED.contains(field)) {
                findings.add(new Finding(at, PlaybookReader.REFUSAL));
                refused = true;
            } else if (SET_BY_OTHERS.contains(field)) {
                findings.add(new Finding(at, SET_BY_OTHERS_SENTENCE));
            } else if (!FIELDS.contains(field)) {
                findings.add(new Finding(at, "unknown field"));
            } else if (isBlockScalar(value)) {
                findings.add(new Finding(at, "a block scalar is not accepted here: write the value on one line"));
            } else {
                switch (field) {
                    case "name" -> name = value;
                    case "description" -> description = value;
                    case "type" -> type = value;
                    default -> skill = value.isEmpty() ? null : value;
                }
            }
        }
        if (refused) {
            return new Read(null, List.copyOf(findings));
        }
        String stem = stem(path);
        if (name == null || name.isEmpty()) {
            findings.add(new Finding(path + "#name", "name is missing; it must equal the file name " + stem));
        } else if (!name.equals(stem)) {
            findings.add(new Finding(path + "#name", "name must equal the file name " + stem + ", not " + name));
        }
        if (description == null || description.isEmpty()) {
            findings.add(new Finding(path + "#description", "description is missing"));
        }
        if (type == null || !TYPES.contains(type)) {
            findings.add(new Finding(path + "#type", "type must be one of " + new TreeSet<>(TYPES).toString()
                    .replace("[", "").replace("]", "")));
        }
        StringBuilder body = new StringBuilder();
        for (int i = close + 1; i < lines.length; i++) {
            body.append(lines[i]).append('\n');
        }
        String preamble = body.toString().replace("\r", "").strip();
        if (preamble.isEmpty()) {
            findings.add(new Finding(path + "#body", "the body is empty: it is the preamble of the agent"));
        }
        return new Read(new AgentFile(name == null ? "" : name, description == null ? "" : description,
                type == null ? "" : type, skill, preamble), List.copyOf(findings));
    }

    private static Read fail(String path, String message) {
        return new Read(null, List.of(new Finding(path, message)));
    }

    private static String stem(String path) {
        String file = path.substring(path.lastIndexOf('/') + 1);
        return file.endsWith(".md") ? file.substring(0, file.length() - 3) : file;
    }

    private static boolean isBlockScalar(String value) {
        return value.matches("[|>][+-]?[0-9]?[+-]?");
    }

    private static String unquote(String value) {
        if (value.length() >= 2) {
            char first = value.charAt(0);
            if ((first == '"' || first == '\'') && value.charAt(value.length() - 1) == first) {
                return value.substring(1, value.length() - 1);
            }
        }
        return value;
    }
}
