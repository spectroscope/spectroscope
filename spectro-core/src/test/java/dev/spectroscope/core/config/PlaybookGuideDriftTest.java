package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The user guide chapter on playbooks against the playbook the product ships.
 *
 * <p>Card 481 adds a third view mode and a bundled playbook. The chapter that
 * tells a reader what a playbook folder holds restates facts that live in the
 * bundle: the top level entries, the model choices, the document types and the
 * node counts. The facts are read off {@code bundled-playbooks/spectro}, so a
 * new document type or a removed step turns this red the day it lands, and
 * the two built editions are checked as well, because the reader opens those
 * and not the part.</p>
 */
class PlaybookGuideDriftTest {

    private static final Path PART = Path.of("docs/guide-assets/parts/11d-playbooks.html");
    private static final Path MODES = Path.of("docs/guide-assets/parts/06b-leveling.html");
    private static final Path BUNDLE =
            Path.of("spectro-server/src/main/resources/bundled-playbooks/spectro");
    private static final List<String> EDITIONS =
            List.of("docs/USER-GUIDE.html", "docs/USER-GUIDE-LIGHT.html");
    private static final ObjectMapper JSON = new ObjectMapper();

    private static final Path I18N = Path.of("spectro-web/src/i18n/i18n.ts");

    private static String runSection(String part) {
        int from = part.indexOf("id=\"ch-playbooks-run\"");
        assertTrue(from >= 0, "the chapter has no run section");
        int next = part.indexOf("<h2 ", from + 10);
        if (next < 0) {
            next = part.length();
        }
        return part.substring(from, next);
    }

    private static String english(String i18n, String key) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile(
                "\"" + java.util.regex.Pattern.quote(key) + "\":\\s*\\{\\s*de:\\s*\"(?:[^\"\\\\]|\\\\.)*\",\\s*en:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
                .matcher(i18n);
        assertTrue(m.find(), "no English text for " + key + " in " + I18N);
        return m.group(1);
    }

    private static Path root() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }

    private static Path rootOrSkip() {
        Path root = root();
        assumeTrue(root != null && Files.isDirectory(root.resolve(BUNDLE)),
                "not running from a source checkout");
        return root;
    }

    private static String chapter(Path root) throws IOException {
        Path part = root.resolve(PART);
        assertTrue(Files.isRegularFile(part),
                PART + " is missing: the guide has no chapter for the playbook module");
        return Files.readString(part);
    }

    private static JsonNode playbook(Path root) throws IOException {
        return JSON.readTree(Files.readString(root.resolve(BUNDLE).resolve("playbook.json")));
    }

    @Test
    void theChapterExistsAndOpensWithItsOwnAnchor() throws IOException {
        String part = chapter(rootOrSkip());
        assertTrue(part.contains("id=\"ch-playbooks\""),
                PART + " carries no h1 with id ch-playbooks");
        assertTrue(part.contains("<h1 data-ch=\"15d\""),
                PART + " is not chapter 15d, the slot after the state graph");
    }

    @Test
    void theChapterNamesEveryTopLevelEntryOfTheShippedBundle() throws IOException {
        Path root = rootOrSkip();
        String part = chapter(root);
        List<String> missing = new ArrayList<>();
        try (Stream<Path> entries = Files.list(root.resolve(BUNDLE))) {
            for (Path entry : entries.sorted().toList()) {
                String name = entry.getFileName().toString();
                String shown = Files.isDirectory(entry) ? name + "/" : name;
                if (!part.contains("<code>" + shown + "</code>")) {
                    missing.add(shown);
                }
            }
        }
        assertEquals(List.of(), missing,
                "the bundle holds entries the chapter's folder layout never names");
    }

    @Test
    void theChapterNamesEveryModelChoiceAndDocumentTypeOfTheShippedPlaybook() throws IOException {
        Path root = rootOrSkip();
        String part = chapter(root);
        JsonNode pb = playbook(root);
        List<String> missing = new ArrayList<>();
        pb.get("models").fieldNames().forEachRemaining(k -> {
            if (!part.contains("<code>" + k + "</code>")) {
                missing.add("model " + k);
            }
        });
        pb.get("documents").fieldNames().forEachRemaining(k -> {
            String name = pb.get("documents").get(k).get("name").asText();
            if (!part.contains(name)) {
                missing.add("document " + name);
            }
        });
        assertEquals(List.of(), missing,
                "the shipped playbook has model choices or document types the chapter omits");
    }

    @Test
    void theChapterStatesTheNodeCountsTheShippedPlaybookActuallyHas() throws IOException {
        Path root = rootOrSkip();
        String part = chapter(root);
        int steps = 0;
        int decisions = 0;
        int ends = 0;
        for (JsonNode n : playbook(root).get("nodes")) {
            switch (n.get("kind").asText()) {
                case "step" -> steps++;
                case "decision" -> decisions++;
                case "end" -> ends++;
                default -> throw new AssertionError("a node kind the chapter does not know");
            }
        }
        String sentence = steps + " steps, " + decisions + " decisions and " + ends + " ends";
        assertTrue(part.contains(sentence),
                "the chapter does not say \"" + sentence + "\", the count in playbook.json");
    }

    @Test
    void theChapterNoLongerSaysThatRunsIgnoreThePlaybookAndStillNamesItsFile() throws IOException {
        String part = chapter(rootOrSkip());
        for (String stale : List.of("Runs do not follow the playbook yet",
                "It does not run anything by it yet",
                "does not run anything by it")) {
            assertFalse(part.contains(stale),
                    "card 482 made runs follow the playbook, the chapter still says: " + stale);
        }
        assertTrue(part.contains("id=\"ch-playbooks-run\""),
                PART + " has no section \"Running a playbook\" with the anchor ch-playbooks-run");
        assertTrue(part.contains("<h2 id=\"ch-playbooks-run\">Running a playbook</h2>"),
                "the run section is not headed \"Running a playbook\"");
        assertTrue(part.contains("developer"), "the chapter never names the developer mode");
        assertTrue(part.contains("<code>playbook.json</code>"), "the chapter never names the file");
    }

    @Test
    void theRunSectionUsesTheWordsTheSheetAndThePaneShow() throws IOException {
        Path root = rootOrSkip();
        String run = runSection(chapter(root));
        String i18n = Files.readString(root.resolve(I18N));
        List<String> missing = new ArrayList<>();
        for (String key : List.of("pb.run.build", "pb.run.start", "pb.run.hash", "pb.run.skills",
                "pb.run.commands", "pb.run.refusals", "pb.run.unrecorded")) {
            String shown = english(i18n, key);
            if (!run.contains("&ldquo;" + shown + "&rdquo;")) {
                missing.add(key + " = \"" + shown + "\"");
            }
        }
        assertEquals(List.of(), missing,
                "the run section does not quote, in &ldquo; and &rdquo;, the English text the window shows for these keys");
    }

    @Test
    void theRunSectionExplainsEveryWayARunEnds() throws Exception {
        String run = runSection(chapter(rootOrSkip()));
        List<String> missing = new ArrayList<>();
        int seen = 0;
        for (java.lang.reflect.Field f : dev.spectroscope.core.playbook.run.RunStop.class.getDeclaredFields()) {
            if (!java.lang.reflect.Modifier.isStatic(f.getModifiers()) || f.getType() != String.class) {
                continue;
            }
            seen++;
            String word = (String) f.get(null);
            if (!run.contains("<code>" + word + "</code>")) {
                missing.add(word);
            }
        }
        assertTrue(seen >= 11, "the stop reasons were not found, saw " + seen);
        assertEquals(List.of(), missing, "the run section leaves out stop reasons the runner can write");
    }

    @Test
    void theRunSectionNamesEveryCheckKindThePlaybookUsesAndBothPrivacyWords() throws IOException {
        Path root = rootOrSkip();
        String run = runSection(chapter(root));
        List<String> kinds = new ArrayList<>();
        for (JsonNode check : playbook(root).get("checks")) {
            String kind = check.get("kind").asText();
            if (!kinds.contains(kind)) {
                kinds.add(kind);
            }
        }
        assertEquals(5, kinds.size(), "the shipped playbook no longer uses the five check kinds");
        List<String> missing = new ArrayList<>();
        for (String kind : kinds) {
            if (!run.contains("<code>" + kind + "</code>")) {
                missing.add(kind);
            }
        }
        for (String word : List.of("private", "cheap")) {
            if (!run.contains("<code>" + word + "</code>")) {
                missing.add(word);
            }
        }
        assertEquals(List.of(), missing, "the run section leaves out check kinds or privacy words");
    }

    @Test
    void theRunSectionDescribesTheSidecarAndEveryRecordTypeItHolds() throws IOException {
        String run = runSection(chapter(rootOrSkip()));
        assertTrue(run.contains("<code>~/.spectro/playbook-runs/</code>"),
                "the run section does not say where the sidecar and the graph files live");
        assertTrue(run.contains(".playbook.jsonl"), "the run section never names the sidecar file");
        assertTrue(run.contains(".graph.jsonl"), "the run section never names the graph file");
        List<String> missing = new ArrayList<>();
        for (String type : new java.util.TreeSet<>(
                dev.spectroscope.core.playbook.run.PlaybookRecorder.TYPES)) {
            if (!run.contains("<code>" + type + "</code>")) {
                missing.add(type);
            }
        }
        assertTrue(dev.spectroscope.core.playbook.run.PlaybookRecorder.TYPES.size() >= 7,
                "the sidecar record types were not found");
        assertEquals(List.of(), missing, "the sidecar holds record types the run section omits");
    }

    @Test
    void theChapterStatesWhatVersionOneOfARunDoesNot() throws IOException {
        String part = chapter(rootOrSkip());
        String limits = part.substring(part.indexOf("id=\"ch-playbooks-limits\""));
        assertTrue(limits.contains("A run does not resume after a restart"),
                "the limits do not say that a run does not resume");
        assertTrue(limits.contains("There is no headless entry"),
                "the limits do not say that a headless run is not offered");
        assertTrue(limits.contains("A shared folder cannot start a run"),
                "the limits do not say that only the confirmation starts a run");
    }

    @Test
    void theChapterUsesNoDashAsPunctuation() throws IOException {
        String part = chapter(rootOrSkip());
        for (String dash : List.of("—", "–", "&mdash;", "&ndash;", "&#8212;", "&#8211;", " -- ")) {
            assertFalse(part.contains(dash), PART + " contains a dash as punctuation: " + dash);
        }
    }

    @Test
    void theModeChapterNamesTheThirdMode() throws IOException {
        Path root = rootOrSkip();
        String text = Files.readString(root.resolve(MODES));
        assertTrue(text.contains("<h2 id=\"leveling-mode\">learn, light or developer</h2>"),
                MODES + " still describes two modes");
        assertTrue(text.contains("<b>developer</b>"),
                MODES + " never explains what developer shows");
    }

    @Test
    void bothBuiltEditionsCarryTheChapterAndTheThirdMode() throws IOException {
        Path root = rootOrSkip();
        for (String name : EDITIONS) {
            Path built = root.resolve(name);
            assertTrue(Files.isRegularFile(built), name + " is gone");
            String edition = Files.readString(built);
            assertTrue(edition.contains("id=\"ch-playbooks\""),
                    name + " has no playbooks chapter: rebuild it (docs/guide-assets/"
                            + "build_user_guide.py, both themes, then the PDFs and --stamp)");
            assertTrue(edition.contains("id=\"ch-playbooks-run\""),
                    name + " has no \"Running a playbook\" section: rebuild it");
            assertTrue(edition.contains("learn, light or developer"),
                    name + " still describes two modes: rebuild it");
        }
    }
}
