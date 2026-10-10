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
    private static final Pattern OPEN_ITEM = Pattern.compile("(?m)^\\s*[-*+]\\s+\\[ ]");

    private DocumentChecks() {
    }

    /**
     * @param docId    the document id, for the detail
     * @param file     the document, or null when it was never found
     * @param sections the headings it must have, each followed by text
     * @param forbid   strings it must not contain
     * @return pass, or fail with every missing, empty and forbidden item named
     */
    public static CheckResult sections(String docId, Path file, List<String> sections, List<String> forbid) {
        String text = read(file);
        if (text == null) {
            return CheckResult.fail(docId + ": not written");
        }
        List<String> lines = text.lines().toList();
        List<String> problems = new ArrayList<>();
        for (String section : sections) {
            int at = -1;
            int level = 0;
            for (int i = 0; i < lines.size(); i++) {
                Matcher m = HEADING.matcher(lines.get(i));
                if (m.matches() && m.group(2).strip().equalsIgnoreCase(section)) {
                    at = i;
                    level = m.group(1).length();
                    break;
                }
            }
            if (at < 0) {
                problems.add("missing section " + section);
                continue;
            }
            boolean body = false;
            for (int i = at + 1; i < lines.size(); i++) {
                Matcher m = HEADING.matcher(lines.get(i));
                if (m.matches() && m.group(1).length() <= level) {
                    break;
                }
                if (!lines.get(i).isBlank()) {
                    body = true;
                    break;
                }
            }
            if (!body) {
                problems.add("empty section " + section);
            }
        }
        for (String word : forbid) {
            if (text.contains(word)) {
                problems.add("forbidden " + word);
            }
        }
        return problems.isEmpty()
                ? CheckResult.pass(docId + ": sections present")
                : CheckResult.fail(docId + ": " + String.join(", ", problems));
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
