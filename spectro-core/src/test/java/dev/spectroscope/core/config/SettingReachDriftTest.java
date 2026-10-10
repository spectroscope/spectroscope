package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.lang.reflect.RecordComponent;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 491: every settings key says when a saved change acts.
 *
 * <p>The reach of a key is written in two places that cannot import each
 * other: {@code SETTING_REACH} in the web's {@code settingsReach.tsx}, which
 * the settings page and the composer gear render as a sentence, and the
 * "When each key lands" table of the config reference chapter. This test
 * derives the key list from the record components of {@link SpectroConfig},
 * so a key added to the record without a reach turns it red on the day it is
 * added, and it holds the two written copies and the vocabulary to each
 * other.</p>
 */
class SettingReachDriftTest {

    private static final Path REACH_TS = Path.of("spectro-web/src/components/settingsReach.tsx");

    private static final Path REFERENCE =
            Path.of("docs/guide-assets/parts/18-ref-config-build.html");

    /** The keys of the "Every key" table that are not record components. */
    private static final Set<String> NOT_A_COMPONENT = Set.of("tts");

    @Test
    void everyKeyOfTheRecordHasAReachInTheWebTable() throws IOException {
        Map<String, String> web = webReach();
        List<String> missing = new ArrayList<>();
        for (String key : recordKeys()) {
            if (!web.containsKey(key)) {
                missing.add(key);
            }
        }
        assertEquals(List.of(), missing,
                "SpectroConfig has keys that SETTING_REACH in " + REACH_TS + " does not"
                        + " classify. Add each with the moment a saved change acts in a"
                        + " session that is already open, measured against the code that"
                        + " reads it");
    }

    @Test
    void everyReachIsAWordOfTheVocabulary() throws IOException {
        Set<String> vocabulary = vocabulary();
        assertTrue(vocabulary.contains("next-run"),
                "the Reach type has no next-run, the moment card 491 added: " + vocabulary);
        for (Map.Entry<String, String> entry : webReach().entrySet()) {
            assertTrue(vocabulary.contains(entry.getValue()),
                    entry.getKey() + " has the reach \"" + entry.getValue() + "\", which the"
                            + " Reach type does not know: " + vocabulary);
        }
    }

    @Test
    void theChapterNamesEveryKeyWithItsReach() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null && Files.isRegularFile(root.resolve(REFERENCE)),
                "not running from a source checkout");
        String chapter = Files.readString(root.resolve(REFERENCE));
        Map<String, String> printed = chapterReach(chapter);

        assertEquals(new ArrayList<>(vocabulary()), chapterWords(chapter),
                "the chapter's reach table must have one row per word of the Reach type,"
                        + " in the type's order");

        Map<String, String> web = webReach();
        for (String key : recordKeys()) {
            assertTrue(printed.containsKey(key),
                    "the chapter's reach table does not name " + key + ", a key of"
                            + " SpectroConfig");
            assertEquals(web.get(key), printed.get(key),
                    key + " has one reach in " + REACH_TS + " and another in the chapter");
        }
        assertEquals(Set.copyOf(keyTableKeys(chapter)), printed.keySet(),
                "the reach table and the \"Every key\" table must name the same keys");
        for (String extra : NOT_A_COMPONENT) {
            assertTrue(printed.containsKey(extra),
                    extra + " is in the \"Every key\" table and needs a reach too");
        }
    }

    /**
     * Pins the two labels in the web table only. When each key really acts is
     * pinned at the session's door: {@code SessionContinuationLeashTest} for
     * the budget, {@code SessionToolGroupsReachTest} for the tool groups.
     */
    @Test
    void theWebTableLabelsTheToolGroupsAndTheContinuationBudgetNextRun() throws IOException {
        Map<String, String> web = webReach();
        assertEquals("next-run", web.get("toolGroupsOff"));
        assertEquals("next-run", web.get("continuationBudget"));
    }

    @Test
    void theNextRunRowSaysAToolGroupsListInAFileWaitsForTheNextSession() throws IOException {
        // Review of card 491. toolGroupsOff acts at the next run only when the
        // composer gear switches it. A list written into a settings file is
        // read when a session starts and when a folder is pinned, never again
        // in an open session (SessionConnection keeps it off liveConfig on
        // purpose). The row must say both halves, or it promises the next run
        // to a file save that never reaches the session.
        Path root = repoRoot();
        assumeTrue(root != null && Files.isRegularFile(root.resolve(REFERENCE)),
                "not running from a source checkout");
        String when = rowDescription(Files.readString(root.resolve(REFERENCE)), "next-run");
        assertTrue(when.contains("composer gear"),
                "the next-run row must name the composer gear as the control that acts at"
                        + " the next run. Row: " + when);
        assertTrue(when.contains("<code>toolGroupsOff</code>"),
                "the next-run row must name toolGroupsOff where it states the exception."
                        + " Row: " + when);
        assertTrue(when.contains("settings file") && when.contains("next session"),
                "the next-run row must say that a toolGroupsOff list saved in a settings"
                        + " file waits for the next session. Row: " + when);
    }

    @Test
    void theIntroductionSaysWhichGearControlPrintsTheReach() throws IOException {
        // Review of card 491. The gear prints a reach sentence under the tool
        // groups only; its other controls switch the session and back no key.
        Path root = repoRoot();
        assumeTrue(root != null && Files.isRegularFile(root.resolve(REFERENCE)),
                "not running from a source checkout");
        String chapter = Files.readString(root.resolve(REFERENCE));
        int heading = chapter.indexOf("id=\"ch-config-reach\"");
        assertTrue(heading > 0, "the heading ch-config-reach is gone");
        String intro = chapter.substring(chapter.indexOf("<p>", heading),
                chapter.indexOf("</p>", heading)).replaceAll("\\s+", " ");
        assertTrue(!intro.contains("composer gear print the same answer under each control"),
                "the introduction says the gear prints a reach under each control. It"
                        + " prints one under the tool groups only. Intro: " + intro);
        assertTrue(intro.contains("composer gear prints it under the tool groups"),
                "the introduction must say where the gear prints the reach. Intro: " + intro);
    }

    @Test
    void theBuiltEditionsCarryTheSameReachTable() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null && Files.isRegularFile(root.resolve(REFERENCE)),
                "not running from a source checkout");
        String table = reachTable(Files.readString(root.resolve(REFERENCE)));
        for (String name : List.of("docs/USER-GUIDE.html", "docs/USER-GUIDE-LIGHT.html")) {
            assertTrue(Files.readString(root.resolve(name)).contains(table),
                    name + " does not carry the chapter's reach table as it stands; rebuild"
                            + " it (docs/guide-assets/build_user_guide.py, both themes, then"
                            + " the PDFs)");
        }
    }

    /** The record's component names, in declaration order. */
    static List<String> recordKeys() {
        List<String> keys = new ArrayList<>();
        for (RecordComponent component : SpectroConfig.class.getRecordComponents()) {
            keys.add(component.getName());
        }
        return keys;
    }

    /** {@code SETTING_REACH} as written, key to reach, comments dropped. */
    static Map<String, String> webReach() throws IOException {
        String source = webSource();
        int start = source.indexOf("export const SETTING_REACH = {");
        assertTrue(start >= 0, "SETTING_REACH has moved or been renamed in " + REACH_TS);
        int end = source.indexOf("} as const", start);
        String body = source.substring(start, end).replaceAll("//[^\n]*", "");
        Map<String, String> reach = new LinkedHashMap<>();
        Matcher entry = Pattern.compile("(?m)^\\s*\"?([A-Za-z][\\w-]*)\"?\\s*:\\s*\"([a-z-]+)\"")
                .matcher(body);
        while (entry.find()) {
            reach.put(entry.group(1), entry.group(2));
        }
        assertTrue(reach.size() > 40, "the parse found " + reach.size() + " entries, too few"
                + " to be the table");
        return reach;
    }

    /** The words of {@code export type Reach}, in their written order. */
    static Set<String> vocabulary() throws IOException {
        Matcher type = Pattern.compile("export type Reach =([^;]*);").matcher(webSource());
        assertTrue(type.find(), "the Reach type has moved or been renamed in " + REACH_TS);
        Set<String> words = new LinkedHashSet<>();
        Matcher word = Pattern.compile("\"([a-z-]+)\"").matcher(type.group(1));
        while (word.find()) {
            words.add(word.group(1));
        }
        return words;
    }

    /** The reach table of the chapter, from its anchor to its end. */
    static String reachTable(String chapter) {
        int at = chapter.indexOf("id=\"ch-config-reach-table\"");
        assertTrue(at > 0, "the chapter has no reach table (id ch-config-reach-table)");
        return chapter.substring(chapter.lastIndexOf("<table", at),
                chapter.indexOf("</table>", at) + "</table>".length());
    }

    /** Each key of the reach table and the word of the row it sits in. */
    static Map<String, String> chapterReach(String chapter) {
        Map<String, String> reach = new LinkedHashMap<>();
        Matcher row = Pattern.compile("(?s)<tr><td><code>([a-z-]+)</code></td><td>.*?</td><td>(.*?)</td></tr>")
                .matcher(reachTable(chapter));
        while (row.find()) {
            Matcher key = Pattern.compile("<code>([A-Za-z]\\w*)</code>").matcher(row.group(2));
            while (key.find()) {
                String previous = reach.put(key.group(1), row.group(1));
                assertTrue(previous == null, key.group(1) + " sits in two rows of the reach table");
            }
        }
        return reach;
    }

    /** The "a saved change acts" cell of the row for {@code word}. */
    static String rowDescription(String chapter, String word) {
        Matcher row = Pattern.compile("(?s)<tr><td><code>" + Pattern.quote(word)
                + "</code></td><td>(.*?)</td><td>").matcher(reachTable(chapter));
        assertTrue(row.find(), "the reach table has no row for " + word);
        return row.group(1).replaceAll("\\s+", " ");
    }

    /** The reach words of the chapter's table, in row order. */
    static List<String> chapterWords(String chapter) {
        List<String> words = new ArrayList<>();
        Matcher row = Pattern.compile("<tr><td><code>([a-z-]+)</code></td>").matcher(reachTable(chapter));
        while (row.find()) {
            words.add(row.group(1));
        }
        return words;
    }

    /** The first-column keys of the "Every key" table. */
    static List<String> keyTableKeys(String chapter) {
        int table = chapter.indexOf("id=\"ch-config-keys\"");
        String keyTable = chapter.substring(table, chapter.indexOf("</table>", table));
        List<String> keys = new ArrayList<>();
        Matcher row = Pattern.compile("<tr><td><code>([^<]+)</code></td>").matcher(keyTable);
        while (row.find()) {
            keys.add(row.group(1));
        }
        return keys;
    }

    private static String webSource() throws IOException {
        Path root = repoRoot();
        assertTrue(root != null && Files.isRegularFile(root.resolve(REACH_TS)),
                REACH_TS + " is not in this checkout; the reach table lives there");
        return Files.readString(root.resolve(REACH_TS));
    }

    /** Walks up to the directory holding the Gradle settings file. */
    private static Path repoRoot() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
