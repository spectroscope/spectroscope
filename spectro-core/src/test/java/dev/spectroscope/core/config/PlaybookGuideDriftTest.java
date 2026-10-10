package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.playbook.Playbook;
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
    private static final Path MANIFEST =
            Path.of("spectro-server/src/main/resources/spectrolyzr/manifest.json");
    private static final List<String> EDITIONS =
            List.of("docs/USER-GUIDE.html", "docs/USER-GUIDE-LIGHT.html");
    private static final ObjectMapper JSON = new ObjectMapper();

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
    void theChapterSaysThatRunsDoNotFollowThePlaybookYet() throws IOException {
        String part = chapter(rootOrSkip());
        assertTrue(part.contains("Runs do not follow the playbook yet"),
                "the chapter must say what version 1 does not do, in the module's own words");
        assertTrue(part.contains("developer"), "the chapter never names the developer mode");
        assertTrue(part.contains("<code>playbook.json</code>"), "the chapter never names the file");
    }

    /** The editor's own words the chapter's edit section has to use, as they appear on the screen. */
    private static final List<String> EDIT_TERMS = List.of(
            "Edit", "Add step", "Add decision", "Add end", "Undo", "Redo", "Save", "Revert");

    @Test
    void theChapterHasASectionForEditingAPlaybookWithTheEditorsOwnWords() throws IOException {
        String part = chapter(rootOrSkip());
        assertTrue(part.contains("<h2 id=\"ch-playbooks-edit\">Editing a playbook</h2>"),
                PART + " has no section \"Editing a playbook\" (id ch-playbooks-edit)");
        String section = part.substring(part.indexOf("id=\"ch-playbooks-edit\""));
        int next = section.indexOf("<h2 ", 10);
        if (next > 0) {
            section = section.substring(0, next);
        }
        List<String> missing = new ArrayList<>();
        for (String term : EDIT_TERMS) {
            if (!section.contains(term)) {
                missing.add(term);
            }
        }
        assertEquals(List.of(), missing, "the edit section never names these buttons");
        assertTrue(section.contains("changed on disk") || section.contains("changed since"),
                "the edit section never explains the refused save after the file changed");
        assertTrue(section.contains("reformat"), "the edit section never says why a first save may reformat");
    }

    @Test
    void theChapterNoLongerSaysTheGraphCannotBeEditedWithTheMouse() throws IOException {
        String part = chapter(rootOrSkip());
        assertFalse(part.contains("You cannot edit the graph with the mouse"),
                PART + " still lists mouse editing under what version 1 does not do");
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
            assertTrue(edition.contains("learn, light or developer"),
                    name + " still describes two modes: rebuild it");
            assertTrue(edition.contains("id=\"ch-playbooks-edit\""),
                    name + " has no section on editing a playbook: rebuild it");
        }
    }

    /** The text of the Spectrolyzr section: from its heading to the next h2. */
    private static String spectrolyzrSection(Path root) throws IOException {
        String part = chapter(root);
        int start = part.indexOf("<h2 id=\"ch-playbooks-spectrolyzr\">Spectrolyzr</h2>");
        assertTrue(start >= 0,
                PART + " has no section \"Spectrolyzr\" (id ch-playbooks-spectrolyzr)");
        String section = part.substring(start);
        int next = section.indexOf("<h2 ", 10);
        return next > 0 ? section.substring(0, next) : section;
    }

    @Test
    void theSpectrolyzrSectionNamesEveryArchetypeLanguageAndAddonOfTheManifest()
            throws IOException {
        Path root = rootOrSkip();
        assumeTrue(Files.isRegularFile(root.resolve(MANIFEST)), "no Spectrolyzr manifest");
        String section = spectrolyzrSection(root);
        JsonNode manifest = JSON.readTree(Files.readString(root.resolve(MANIFEST)));
        List<String> wanted = new ArrayList<>();
        for (JsonNode a : manifest.get("archetypes")) {
            wanted.add(a.get("name").get("en").asText());
        }
        for (JsonNode l : manifest.get("languages")) {
            wanted.add(l.get("name").asText());
        }
        for (JsonNode a : manifest.get("addons")) {
            wanted.add(a.get("name").get("en").asText());
        }
        assertEquals(3 + 3 + 3, wanted.size(),
                "the manifest no longer holds three archetypes, languages and add-ons");
        List<String> missing = new ArrayList<>();
        for (String name : wanted) {
            if (!section.contains(name)) {
                missing.add(name);
            }
        }
        assertEquals(List.of(), missing,
                "the Spectrolyzr section never names these choices of the manifest");
    }

    @Test
    void theSpectrolyzrSectionSaysWhereThePlaybookGoesAndWhatItDoesNotDo() throws IOException {
        String section = spectrolyzrSection(rootOrSkip());
        assertTrue(section.contains("New project"), "the section never names the tab");
        assertTrue(section.contains("sibling"),
                "the section never says the playbook lives in a sibling folder");
        assertTrue(section.contains("pinned"), "the section never says the playbook is pinned");
        assertTrue(section.contains("never overwrites"),
                "the section never says generate does not overwrite");
        assertTrue(section.contains("no Gradle wrapper"),
                "the section never says a generated Java project has no wrapper yet");
        assertTrue(section.contains("Generate"), "the section never names the Generate button");
    }

    @Test
    void bothBuiltEditionsCarryTheSpectrolyzrSection() throws IOException {
        Path root = rootOrSkip();
        for (String name : EDITIONS) {
            String edition = Files.readString(root.resolve(name));
            assertTrue(edition.contains("id=\"ch-playbooks-spectrolyzr\""),
                    name + " has no Spectrolyzr section: rebuild it (docs/guide-assets/"
                            + "build_user_guide.py, both themes, then the PDFs and --stamp)");
        }
    }

    private static final String INSTALL_ANCHOR = "id=\"ch-playbooks-install\"";

    /** The section of the chapter that tells what an install writes, cut at the next h2, whitespace collapsed. */
    private static String installSection(String chapter) {
        int at = chapter.indexOf(INSTALL_ANCHOR);
        assertTrue(at >= 0, PART + " has no section with id ch-playbooks-install");
        int end = chapter.indexOf("<h2 ", at);
        String section = end < 0 ? chapter.substring(at) : chapter.substring(at, end);
        return section.replaceAll("\\s+", " ");
    }

    @Test
    void theChapterHasASectionOnInstallingWhatAPlaybookBrings() throws IOException {
        String part = chapter(rootOrSkip());
        assertTrue(part.contains("<h2 " + INSTALL_ANCHOR + ">Installing what a playbook brings</h2>"),
                PART + " has no h2 \"Installing what a playbook brings\"");
    }

    /** The folder names a playbook can carry: the components of the contents record, read by reflection. */
    private static List<String> contentKinds() {
        List<String> kinds = new ArrayList<>();
        for (java.lang.reflect.RecordComponent c : Playbook.Contents.class.getRecordComponents()) {
            kinds.add(c.getName());
        }
        return kinds;
    }

    @Test
    void theLoaderChecksTheSameKindsTheContentsRecordNames() throws IOException {
        Path root = rootOrSkip();
        String loader = Files.readString(root.resolve(
                "spectro-server/src/main/java/dev/spectroscope/server/playbooks/PlaybookLoader.java"));
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("lists\\.put\\(\"([a-z]+)\"").matcher(loader);
        List<String> checked = new ArrayList<>();
        while (m.find()) {
            checked.add(m.group(1));
        }
        assertEquals(contentKinds().stream().sorted().toList(), checked.stream().sorted().toList(),
                "PlaybookLoader.contentsFindings checks other kinds than the contents record declares");
    }

    @Test
    void theAgentsRowPromisesNoRunTheRunnerCannotDoYet() throws IOException {
        String section = installSection(chapter(rootOrSkip()));
        assertFalse(section.contains("runs a child agent"),
                "the Agents row says a step runs a child agent with the preamble: the runner does not resolve "
                        + "agent:name yet (cards 482 and P3), and the chapter says runs do not follow the playbook");
        assertTrue(section.contains("once runs follow the playbook"),
                "the Agents row does not say that using the preamble waits for runs that follow the playbook");
    }

    @Test
    void theInstallSectionNamesEveryKindAndWhatEachBecomes() throws IOException {
        String section = installSection(chapter(rootOrSkip()));
        List<String> missing = new ArrayList<>();
        List<String> kinds = contentKinds();
        assertTrue(kinds.size() >= 5, "the contents record lost kinds: " + kinds);
        for (String kind : kinds) {
            if (!section.contains("<code>" + kind + "/</code>")) {
                missing.add(kind);
            }
        }
        assertEquals(List.of(), missing, "the install section leaves out a kind of content");
        assertTrue(section.contains("<code>~/.spectro/skills/</code>"),
                "the section never says where skills and commands land");
        assertTrue(section.contains("<code>~/.spectro/playbook-hooks/</code>"),
                "the section never says where hook scripts are copied");
        assertTrue(section.contains("<code>{hooks}</code>"),
                "the section never names the placeholder that resolves to the script folder");
        assertTrue(section.contains("<code>/&lt;playbook id&gt;:&lt;name&gt;</code>"),
                "the section never says how a command is invoked");
    }

    @Test
    void theInstallSectionStatesTheRulesThatProtectTheReader() throws IOException {
        String section = installSection(chapter(rootOrSkip()));
        assertTrue(section.contains("off by default"), "the hooks tick is not described as off by default");
        assertTrue(section.contains("before the permission check"),
                "the section never says a hook runs before the permission check");
        assertTrue(section.contains("characters"), "the section never mentions the prompt cost line");
        assertTrue(section.contains("<code>~/.spectro/playbook-installs.json</code>"),
                "the section never names the install ledger");
        assertTrue(section.contains("edited"), "the section never says how remove treats an edited copy");
        assertTrue(section.contains("is not run"), "the section never says that workflows are not run");
        assertTrue(section.contains("remove it first"), "the section never says a second install is refused");
    }

    @Test
    void theLedgerAndHookFolderNamesMatchWhatTheServerWrites() throws IOException {
        Path root = rootOrSkip();
        String section = installSection(chapter(root));
        String ledger = Files.readString(root.resolve(
                "spectro-server/src/main/java/dev/spectroscope/server/playbooks/InstallLedger.java"));
        String installer = Files.readString(root.resolve(
                "spectro-server/src/main/java/dev/spectroscope/server/playbooks/PlaybookInstaller.java"));
        assertTrue(ledger.contains("\"playbook-installs.json\"") && section.contains("playbook-installs.json"),
                "the ledger file name in the chapter and in InstallLedger differ");
        assertTrue(installer.contains("\"playbook-hooks\"") && section.contains("playbook-hooks"),
                "the hook folder name in the chapter and in PlaybookInstaller differ");
    }

    @Test
    void theLimitsNoLongerSayThatContentsAreNotInstalled() throws IOException {
        String part = chapter(rootOrSkip());
        assertFalse(part.contains("are not installed into your"),
                "the limits still say a playbook's contents are not installed");
        assertFalse(part.contains("and that is all"),
                "the chapter still says the step table only reports installed skills");
        assertTrue(part.contains("Workflow files are listed and not run"),
                "the limits do not say what stays out: workflow files are listed and not run");
    }

    @Test
    void bothBuiltEditionsCarryTheInstallSection() throws IOException {
        Path root = rootOrSkip();
        for (String name : EDITIONS) {
            String edition = Files.readString(root.resolve(name));
            assertTrue(edition.contains(INSTALL_ANCHOR),
                    name + " has no install section: rebuild it (docs/guide-assets/"
                            + "build_user_guide.py, both themes, then the PDFs and --stamp)");
        }
    }
}
