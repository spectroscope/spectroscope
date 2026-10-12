package dev.spectroscope.server.playbooks;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Text rules for a hook command (card 538): which hidden entry of the home it names, whether a path
 * after {@code {project}} climbs above the project, and how a placeholder is put back with the shell
 * quoting of the place it stands in.
 *
 * <p>The checks read the command as text. A path the shell builds another way, through a variable,
 * a command substitution or a glob with more than one letter in it, is not found.
 */
final class HookCommands {

    private HookCommands() {
    }

    /** Where a path in a shell word or a value may start: not inside another path or word. */
    static final String WORD_START = "(?<![\\w./~$}-])";
    /** A name right after a slash, up to the next separator. */
    private static final String ENTRY = "/([^/\\s=:;,)|&<>]+)";
    private static final Pattern HOME_ENTRY = Pattern.compile(WORD_START + "~" + ENTRY);
    /** {@code ${HOME}} with or without a parameter operator such as {@code :?} or {@code :-x}. */
    private static final Pattern HOME_PARAMETER = Pattern.compile("\\$\\{HOME(?:[:]?[-=?+][^}]*)?}");
    private static final Pattern HOME_VARIABLE = Pattern.compile("\\$HOME(?![A-Za-z0-9_])");
    /** A glob class that holds one letter, which matches only that letter. */
    private static final Pattern ONE_LETTER_CLASS = Pattern.compile("\\[([^\\]/!^])]");
    private static final Pattern DOUBLE_SLASH = Pattern.compile("//+");
    private static final Pattern DOT_SEGMENT = Pattern.compile("/\\./");
    /** A plain segment after a slash followed by {@code ..}: the two cancel out. */
    private static final Pattern UP_SEGMENT = Pattern.compile("(?<=/)(?!\\.\\.?/)[^/\\s;&|()<>]+/\\.\\./");
    /** A {@code cd} to the home: bare, or to {@code ~} after the home spellings became {@code ~}. */
    private static final Pattern CD_HOME = Pattern.compile("(?:^|(?<=[\\s;&|(]))cd(?:\\s+~/?)?\\s*(?=$|[;&|)])");
    private static final Pattern NEXT_CD = Pattern.compile("(?:^|(?<=[\\s;&|(]))cd(?=\\s|$)");
    /** A relative path whose first name starts with a dot, after an optional {@code ./}. */
    private static final Pattern RELATIVE_DOT = Pattern.compile(
            "(?<![^\\s;&|(=])(?:\\./)*\\.([^./\\s=:;,)|&<>][^/\\s=:;,)|&<>]*)");

    /**
     * The first entry right below the home whose name starts with a dot that {@code command} names,
     * as {@code ~/.<name>}, or null for none. Before it looks, quotes and backslashes are dropped,
     * {@code $HOME}, {@code ${HOME}}, {@code ${HOME:?}} and the absolute and real path of the home
     * become {@code ~}, a glob class of one letter becomes the letter, and {@code //}, {@code /./}
     * and {@code name/..} are folded. After a {@code cd} to the home, a relative path that starts
     * with a dot counts too.
     *
     * @param command the hook command
     * @param home    the home folder
     * @return {@code ~/.<name>} or null
     */
    static String homeDotFolder(String command, Path home) {
        String text = folded(command, home);
        String first = null;
        int at = Integer.MAX_VALUE;
        Matcher m = HOME_ENTRY.matcher(text);
        while (m.find()) {
            String name = m.group(1);
            if (name.startsWith(".") && !name.equals(".") && !name.equals("..") && m.start() < at) {
                at = m.start();
                first = "~/" + name;
            }
        }
        Matcher cd = CD_HOME.matcher(text);
        int from = 0;
        while (cd.find(from)) {
            Matcher next = NEXT_CD.matcher(text);
            int end = next.find(cd.end()) ? next.start() : text.length();
            Matcher rel = RELATIVE_DOT.matcher(text).region(cd.end(), end);
            rel.useTransparentBounds(true);
            if (rel.find() && rel.start() < at) {
                at = rel.start();
                first = "~/." + rel.group(1);
            }
            from = Math.max(cd.end(), cd.start() + 1);
            if (from >= text.length()) {
                break;
            }
        }
        return first;
    }

    /** The command as {@link #homeDotFolder} reads it. */
    static String folded(String command, Path home) {
        String text = command.replace("'", "").replace("\"", "").replace("\\", "");
        text = ONE_LETTER_CLASS.matcher(text).replaceAll(r -> Matcher.quoteReplacement(r.group(1)));
        text = HOME_PARAMETER.matcher(text).replaceAll("~");
        text = HOME_VARIABLE.matcher(text).replaceAll("~");
        for (String h : spellings(home)) {
            text = Pattern.compile(Pattern.quote(h) + "(?=/|$|[\\s=:;,)|&<>])").matcher(text).replaceAll("~");
        }
        String before;
        do {
            before = text;
            text = DOUBLE_SLASH.matcher(text).replaceAll("/");
            text = DOT_SEGMENT.matcher(text).replaceAll("/");
            text = UP_SEGMENT.matcher(text).replaceAll("");
        } while (!text.equals(before));
        return text;
    }

    /**
     * Whether a path after {@code placeholder} in {@code command} climbs above it: a {@code ..}
     * segment that is not cancelled by a plain segment before it. Quotes and backslashes inside the
     * path word are read through.
     */
    static boolean climbsAbove(String command, String placeholder) {
        char quote = 0;
        for (int i = 0; i < command.length(); i++) {
            if (command.startsWith(placeholder, i)) {
                if (climbs(word(command, i + placeholder.length(), quote))) {
                    return true;
                }
                i += placeholder.length() - 1;
                continue;
            }
            char c = command.charAt(i);
            if (c == '\\' && quote != '\'') {
                i++;
            } else if (quote == 0 && (c == '\'' || c == '"')) {
                quote = c;
            } else if (c == quote) {
                quote = 0;
            }
        }
        return false;
    }

    /** Whether a path that starts with a slash has a {@code ..} segment no plain segment before it cancels. */
    private static boolean climbs(String rest) {
        if (!rest.startsWith("/")) {
            return false;
        }
        int depth = 0;
        for (String segment : rest.substring(1).split("/", -1)) {
            if (segment.equals("..")) {
                if (--depth < 0) {
                    return true;
                }
            } else if (!segment.isEmpty() && !segment.equals(".")) {
                depth++;
            }
        }
        return false;
    }

    /**
     * The rest of the shell word from {@code from}, read in the quote {@code quote} the word is in
     * there, with its quotes and backslashes taken out.
     */
    private static String word(String command, int from, char quote) {
        StringBuilder out = new StringBuilder();
        for (int i = from; i < command.length(); i++) {
            char c = command.charAt(i);
            if (quote == 0 && (Character.isWhitespace(c) || ";&|<>()".indexOf(c) >= 0)) {
                break;
            }
            if (c == '\\' && quote != '\'' && i + 1 < command.length()) {
                out.append(command.charAt(++i));
            } else if (quote == 0 && (c == '\'' || c == '"')) {
                quote = c;
            } else if (c == quote) {
                quote = 0;
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    /** A value the shell reads as one plain word with no quotes. */
    private static final Pattern PLAIN = Pattern.compile("[A-Za-z0-9_./+,:@%=-]+");

    /**
     * {@code command} with each placeholder of {@code values} put back, quoted for the place it
     * stands in: outside quotes as a single-quoted word unless the value is plain, inside double
     * quotes with {@code \ $ ` "} escaped, inside single quotes with each {@code '} closed and
     * reopened. The shell then reads the value as it is and never runs any part of it.
     *
     * @param command the hook command with its placeholders
     * @param values  placeholder to the text it stands for
     * @return the command to install
     */
    static String substitute(String command, Map<String, String> values) {
        StringBuilder out = new StringBuilder();
        char quote = 0;
        int i = 0;
        outer:
        while (i < command.length()) {
            for (Map.Entry<String, String> e : values.entrySet()) {
                if (command.startsWith(e.getKey(), i)) {
                    out.append(quoted(e.getValue(), quote));
                    i += e.getKey().length();
                    continue outer;
                }
            }
            char c = command.charAt(i);
            out.append(c);
            if (c == '\\' && quote != '\'' && i + 1 < command.length()) {
                out.append(command.charAt(i + 1));
                i += 2;
                continue;
            }
            if (quote == 0 && (c == '\'' || c == '"')) {
                quote = c;
            } else if (c == quote) {
                quote = 0;
            }
            i++;
        }
        return out.toString();
    }

    private static String quoted(String value, char quote) {
        if (quote == '\'') {
            return value.replace("'", "'\\''");
        }
        if (quote == '"') {
            StringBuilder out = new StringBuilder();
            for (char c : value.toCharArray()) {
                if ("\\$`\"".indexOf(c) >= 0) {
                    out.append('\\');
                }
                out.append(c);
            }
            return out.toString();
        }
        return PLAIN.matcher(value).matches() ? value : "'" + value.replace("'", "'\\''") + "'";
    }

    /** The path as given and as its real path, longest first, as text. */
    static List<String> spellings(Path path) {
        Set<String> out = new LinkedHashSet<>();
        try {
            out.add(path.toRealPath().toString());
        } catch (IOException absent) {
            // a folder that is not there has only the one spelling
        }
        out.add(path.toString());
        List<String> sorted = new ArrayList<>(out);
        sorted.sort(Comparator.comparingInt(String::length).reversed());
        return sorted;
    }
}
