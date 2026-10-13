package dev.spectroscope.core.playbook.run;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** The two document checks that need no model and no shell. */
public final class DocumentChecks {

    private static final Pattern HEADING = Pattern.compile("^(#{1,6})\\s+(.+?)\\s*#*\\s*$");
    /**
     * Card 596: a line that starts with a bold field, {@code **Goal:**} or {@code **Goal**:}, and the text
     * after it. The name holds no {@code *}, so two bold words on one line are no field.
     */
    private static final Pattern BOLD_FIELD = Pattern.compile("^\\*\\*([^*]+?)(?::\\*\\*|\\*\\*:)(.*)$");
    /** A line that opens or closes a fenced code block. */
    private static final Pattern FENCE = Pattern.compile("^\\s*```");
    private static final Pattern OPEN_ITEM = Pattern.compile("(?m)^\\s*[-*+]\\s+\\[ ]");

    private DocumentChecks() {
    }

    /**
     * A section is a Markdown heading with its name, or, when the document has
     * no such heading, a line outside a fenced code block that starts with its
     * name as a bold field such as {@code **Goal:**}, the header form of the
     * bundled planning skill (card 596). Either form matches the name without
     * regard to case; the first line of a name is the section.
     *
     * @param docId    the document id, for the detail
     * @param file     the document, or null when it was never found
     * @param sections the sections it must have, each followed by text
     * @param forbid   strings it must not contain
     * @return pass, or fail with every missing, empty and forbidden item named; when
     *         a section is missing, the detail also names the two forms a section may take
     */
    public static CheckResult sections(String docId, Path file, List<String> sections, List<String> forbid) {
        String text = read(file);
        if (text == null) {
            return CheckResult.fail(docId + ": not written");
        }
        List<String> lines = text.lines().toList();
        List<String> problems = new ArrayList<>();
        String firstMissing = null;
        boolean[] fenced = fenced(lines);
        for (String section : sections) {
            String content = content(lines, fenced, section);
            if (content == null) {
                problems.add("missing section " + section);
                if (firstMissing == null) {
                    firstMissing = section;
                }
            } else if (content.isBlank()) {
                problems.add("empty section " + section);
            }
        }
        if (firstMissing != null) {
            int last = problems.size() - 1;
            problems.set(last, problems.get(last) + " (" + forms(firstMissing) + ")");
        }
        for (String word : forbid) {
            if (text.contains(word)) {
                problems.add("forbidden " + word);
            }
        }
        if (problems.isEmpty()) {
            return CheckResult.pass(docId + ": sections present");
        }
        return CheckResult.fail(docId + ": " + String.join(", ", problems));
    }

    /**
     * @param section a section name
     * @return the clause that names the two forms a section may take, with this name as the example,
     *         and where the text of a bold field ends
     */
    static String forms(String section) {
        return "a section is a heading such as \"## " + section + "\" or a line that starts with \"**" + section
                + ":**\"; such a line's text runs up to the next bold field line or the next # or ## heading";
    }

    /** @return per line, whether it is a fence line or lies inside a fenced code block */
    private static boolean[] fenced(List<String> lines) {
        boolean[] out = new boolean[lines.size()];
        boolean open = false;
        for (int i = 0; i < lines.size(); i++) {
            boolean fence = FENCE.matcher(lines.get(i)).find();
            out[i] = open || fence;
            if (fence) {
                open = !open;
            }
        }
        return out;
    }

    /**
     * The text of a section. Under a heading it runs up to the next heading with
     * as many or fewer {@code #}, as before. After a bold field it is the rest of
     * the field's line and the lines after it up to the next bold field line or
     * the next heading of level 1 or 2, so the {@code ### Task} blocks under a
     * {@code **Tasks:**} field fill it (card 596 review). A bold field inside a
     * fenced code block never starts a section.
     *
     * @param fenced per line, whether it lies in a fenced code block
     * @return the text, blank when the section has none, null when the document has neither form
     */
    private static String content(List<String> lines, boolean[] fenced, String section) {
        for (int i = 0; i < lines.size(); i++) {
            Matcher m = HEADING.matcher(lines.get(i));
            if (m.matches() && m.group(2).strip().equalsIgnoreCase(section)) {
                int level = m.group(1).length();
                StringBuilder out = new StringBuilder();
                for (int j = i + 1; j < lines.size(); j++) {
                    Matcher next = HEADING.matcher(lines.get(j));
                    if (next.matches() && next.group(1).length() <= level) {
                        break;
                    }
                    out.append(lines.get(j)).append('\n');
                }
                return out.toString();
            }
        }
        for (int i = 0; i < lines.size(); i++) {
            Matcher m = BOLD_FIELD.matcher(lines.get(i));
            if (!fenced[i] && m.matches() && m.group(1).strip().equalsIgnoreCase(section)) {
                StringBuilder out = new StringBuilder(m.group(2)).append('\n');
                for (int j = i + 1; j < lines.size(); j++) {
                    Matcher next = HEADING.matcher(lines.get(j));
                    if ((next.matches() && next.group(1).length() <= 2)
                            || BOLD_FIELD.matcher(lines.get(j)).matches()) {
                        break;
                    }
                    out.append(lines.get(j)).append('\n');
                }
                return out.toString();
            }
        }
        return null;
    }

    /** @param docId the id; @param file the document; @return fail with the count when a box is unchecked */
    public static CheckResult openItems(String docId, Path file) {
        String text = read(file);
        if (text == null) {
            return CheckResult.fail(docId + ": not written");
        }
        long open = OPEN_ITEM.matcher(text).results().count();
        return open == 0
                ? CheckResult.pass(docId + ": no open items")
                : CheckResult.fail(docId + ": " + open + " open items");
    }

    private static String read(Path file) {
        if (file == null || !Files.isRegularFile(file)) {
            return null;
        }
        try {
            return Files.readString(file);
        } catch (IOException unreadable) {
            return null;
        }
    }
}
