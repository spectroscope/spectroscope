package dev.spectroscope.core.peer;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The rule the auto modes apply before they approve a gated call (card 503
 * criterion 5, concept section Tools): a message from another agent is never
 * operator intent, and an action the sender says it was denied is refused.
 *
 * <p>The product has no model classifier in front of {@code auto} and
 * {@code extended}; both approve every gated call (card 453). This rule sits
 * in that place and is deterministic: a call is blocked when a peer message
 * this run absorbed says something was denied and also names what the call
 * would do: the command line, each command it chains or wraps in a shell
 * (with its first two words), or a path or its file name. A different command
 * with the same effect, or a message that names no command, passes. The block
 * is a refusal the gate audit records; the operator can still do the thing by
 * hand.</p>
 */
public final class PeerRelayRule {

    /** The label the gate audit records for a call this rule blocked. */
    public static final String DECIDED_BY = "peer-relay";

    private static final Pattern DENIAL = Pattern.compile("(?iu)\\b(denied|refused|rejected|declined|not allowed|"
            + "not permitted|not authori[sz]ed|unauthori[sz]ed|disallowed|prohibited|said no|blocked|forbidden|"
            + "no permission|without permission|verweigert|abgelehnt|untersagt|nicht erlaubt|nicht gestattet|"
            + "nicht berechtigt|nicht autorisiert|keine berechtigung|blockiert)\\b");

    private PeerRelayRule() {
    }

    /**
     * Whether a gated call carries out an action a peer says it was denied.
     *
     * @param bodies   the bodies of the peer messages the run absorbed
     * @param toolName the gated tool
     * @param input    its input
     * @return true when the call must not be approved without the operator
     */
    public static boolean blocks(List<String> bodies, String toolName, JsonNode input) {
        if (bodies == null || bodies.isEmpty() || input == null) {
            return false;
        }
        List<String> marks = marks(input);
        if (marks.isEmpty()) {
            return false;
        }
        for (String body : bodies) {
            if (body == null) {
                continue;
            }
            String said = normal(body);
            if (!DENIAL.matcher(said).find()) {
                continue;
            }
            for (String mark : marks) {
                if (said.contains(mark)) {
                    return true;
                }
            }
        }
        return false;
    }

    /** What a call would do, in the words a peer would use for it. */
    private static List<String> marks(JsonNode input) {
        List<String> marks = new ArrayList<>();
        Iterator<Map.Entry<String, JsonNode>> fields = input.fields();
        while (fields.hasNext()) {
            Map.Entry<String, JsonNode> field = fields.next();
            if (!field.getValue().isTextual() || "content".equals(field.getKey())) {
                continue;
            }
            String value = normal(field.getValue().asText());
            add(marks, value);
            if ("command".equals(field.getKey())) {
                for (String part : parts(field.getValue().asText())) {
                    add(marks, part);
                    String[] words = part.split(" ");
                    if (words.length > 2) {
                        add(marks, words[0] + " " + words[1]);
                    }
                }
            }
            int slash = value.lastIndexOf('/');
            if (slash >= 0) {
                add(marks, value.substring(slash + 1));
                String[] parts = value.split("/");
                if (parts.length >= 2) {
                    add(marks, parts[parts.length - 2] + "/" + parts[parts.length - 1]);
                }
            }
        }
        return marks;
    }

    /**
     * The commands one command line runs: the line split at {@code &&},
     * {@code ||}, {@code ;}, {@code |}, {@code &} and line breaks, quotes
     * taken out, and a leading {@code sh -c} (or bash, zsh, dash, ksh, with
     * or without a path), {@code sudo}, {@code env} with its assignments,
     * {@code nohup}, {@code time}, {@code exec} or {@code command} removed.
     */
    static List<String> parts(String line) {
        // split before the white space is folded, so a line break still separates
        List<String> parts = new ArrayList<>();
        for (String piece : SEPARATOR.split(line.replace('\'', ' ').replace('"', ' '))) {
            String part = normal(piece);
            String before;
            do {
                before = part;
                part = WRAPPER.matcher(part).replaceFirst("").strip();
            } while (!part.equals(before));
            if (!part.isEmpty()) {
                parts.add(part);
            }
        }
        return parts;
    }

    private static final Pattern SEPARATOR = Pattern.compile("&&|\\|\\||;|\\||&|\\n|\\$\\(|\\)");

    private static final Pattern WRAPPER = Pattern.compile("^(?:(?:\\S*/)?(?:sh|bash|zsh|dash|ksh) -c |sudo |nohup |"
            + "time |exec |command |env (?:\\S+=\\S* )*)");

    private static void add(List<String> marks, String mark) {
        if (mark.length() >= PeerLimits.RELAY_MARK_MIN_CHARS && !marks.contains(mark)) {
            marks.add(mark);
        }
    }

    /** Lower case, format characters gone, every kind of space one plain space. */
    private static String normal(String text) {
        return FORMAT.matcher(text.toLowerCase(Locale.ROOT).replace('`', ' ')).replaceAll("")
                .replaceAll("(?U)\\s+", " ").strip();
    }

    private static final Pattern FORMAT = Pattern.compile("\\p{Cf}");
}
