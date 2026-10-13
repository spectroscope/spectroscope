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

    /** Every spelling of a row of the shared command list, as the chat takes it, with its slash. */
    private static List<String> spellings(String id) {
        dev.spectroscope.core.commands.CommandList.Command row = dev.spectroscope.core.commands.CommandList.all()
                .stream().filter(c -> c.id().equals(id)).findFirst().orElseThrow();
        List<String> out = new ArrayList<>();
        out.add("/" + (row.sub() == null ? row.name() : row.name() + " " + row.sub()));
        row.aliases().forEach(a -> out.add("/" + a));
        return out;
    }

    /**
     * Card 554: a run starts from the chat of a session with
     * {@code /run-with-playbook} and the playbook the session picked in the
     * header chip; the Playbook view's first tab, Steps, starts nothing. The
     * section quotes the chip's words, the sheet's and the tab's, and names
     * every spelling of the command from the shared command list.
     */
    @Test
    void theRunSectionUsesTheWordsTheSheetAndThePaneShow() throws IOException {
        Path root = rootOrSkip();
        String run = runSection(chapter(root));
        String i18n = Files.readString(root.resolve(I18N));
        List<String> missing = new ArrayList<>();
        for (String spelling : spellings("run-with-playbook")) {
            if (!run.contains("<code>" + spelling + "</code>")) {
                missing.add(spelling);
            }
        }
        for (String key : List.of("pbchip.noPlaybook", "pbchip.suggested", "pb.run.confirmTitle", "pbb.tab.steps",
                "pb.run.start", "pb.run.hash", "pb.run.skills", "pb.run.commands", "pb.run.refusals",
                "pb.run.unrecorded")) {
            String shown = english(i18n, key);
            if (!run.contains("&ldquo;" + shown + "&rdquo;")) {
                missing.add(key + " = \"" + shown + "\"");
            }
        }
        assertEquals(List.of(), missing,
                "the run section does not quote, in &ldquo; and &rdquo;, the English text the window shows for these keys");
        assertFalse(chapter(root).contains("Build by this"), PART + " still names the pane's start button");
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

    /**
     * Nothing is installed (owner, 2026-10-13): the limits say which change after the
     * confirmation stops the start (a file under the hash) and which does not, and they no
     * longer compare with an install.
     */
    @Test
    void theLimitsSayWhichChangeAfterTheConfirmationStopsARun() throws IOException {
        String part = chapter(rootOrSkip());
        String limits = part.substring(part.indexOf("id=\"ch-playbooks-limits\"")).replaceAll("\\s+", " ");
        assertTrue(limits.contains("after you read the commands, the contents and the hash"),
                "the limits do not say that the sheet shows the contents before a run");
        assertTrue(limits.contains("does not stop a run"),
                "the limits do not say that a changed item is shown and does not stop a run");
        assertTrue(limits.contains("agent file"),
                "the limits do not name the agent file as a change that stops a run");
        assertTrue(limits.contains("after the confirmation stops the start"),
                "the limits do not say that a change to a file under the hash stops the start");
        assertFalse(limits.contains("since the install") || limits.contains("file that was installed"),
                "the limits still compare with an install");
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

    /** The section of the chapter that tells what a playbook brings, cut at the next h2, whitespace collapsed. */
    private static String contentsSection(String chapter) {
        int at = chapter.indexOf(INSTALL_ANCHOR);
        assertTrue(at >= 0, PART + " has no section with id ch-playbooks-install");
        int end = chapter.indexOf("<h2 ", at);
        String section = end < 0 ? chapter.substring(at) : chapter.substring(at, end);
        return section.replaceAll("\\s+", " ");
    }

    /** Owner answer of 2026-10-13 (card 558): nothing installs a playbook's contents, so the section is named for them. */
    @Test
    void theChapterHasASectionOnThePlaybookContents() throws IOException {
        String part = chapter(rootOrSkip());
        assertTrue(part.contains("<h2 " + INSTALL_ANCHOR + ">Playbook contents</h2>"),
                PART + " has no h2 \"Playbook contents\"");
        assertTrue(part.contains("described under &ldquo;Playbook contents&rdquo;"),
                "the format section does not point at the contents section by its name");
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

    /**
     * The refusal words of an agent role in the runner's pin, read from its source. Card 558: the
     * file is read from the playbook folder in place, so the install refusals are gone.
     */
    private static final List<String> AGENT_REFUSALS = List.of("agent not found");

    @Test
    void theAgentsRowSaysWhatTheRunnerDoesWithAnAgentRoleAndWhenItRefuses() throws IOException {
        Path root = rootOrSkip();
        String section = contentsSection(chapter(root));
        String pin = Files.readString(root.resolve(
                "spectro-core/src/main/java/dev/spectroscope/core/playbook/run/PinnedPlaybook.java"));
        assertFalse(section.contains("once runs follow the playbook"),
                "the Agents row still says the preamble waits for runs that follow the playbook: since the card 485 "
                        + "follow-up the runner resolves agent:name");
        assertTrue(section.contains("<code>agent:name</code>"), "the Agents row never names the role agent:name");
        assertTrue(section.contains("type and preamble"),
                "the Agents row does not say that the child runs on the agent file's type and preamble");
        List<String> missing = new ArrayList<>();
        for (String refusal : AGENT_REFUSALS) {
            assertTrue(pin.contains("\"" + refusal + ": \""),
                    "PinnedPlaybook no longer refuses with \"" + refusal + "\"; correct this test and the chapter");
            if (!section.contains("&ldquo;" + refusal + "&rdquo;")) {
                missing.add(refusal);
            }
        }
        assertEquals(List.of(), missing,
                "the contents section does not quote the refusal a run gives for an agent file it cannot read");
        assertFalse(section.contains("agent not installed") || section.contains("agent changed since install"),
                "the Agents row still quotes an install refusal the runner no longer gives (card 558)");
    }

    @Test
    void theRunSectionNamesTheContentsTheConfirmationListsInTheSheetsOwnWords() throws IOException {
        Path root = rootOrSkip();
        String run = runSection(chapter(root)).replaceAll("\\s+", " ");
        String i18n = Files.readString(root.resolve(I18N));
        String title = english(i18n, "pc.runTitle");
        assertTrue(run.contains("&ldquo;" + title + "&rdquo;"),
                "the run section does not quote the contents section of the sheet: " + title);
        String inPlaybook = english(i18n, "pc.state.inPlaybook");
        assertTrue(run.contains("&ldquo;" + inPlaybook + "&rdquo;"),
                "the run section does not quote the mark the contents list gives an item: " + inPlaybook);
        assertFalse(run.contains("changed since the install") || run.contains("the list the install shows"),
                "the run section still says that the sheet names what changed since an install");
        assertTrue(run.contains("every agent file a step names"),
                "the run section does not say that the run hash covers the agent files the steps name");
    }

    @Test
    void theContentsSectionNamesEveryKindAndWhatASessionGets() throws IOException {
        String section = contentsSection(chapter(rootOrSkip()));
        List<String> missing = new ArrayList<>();
        List<String> kinds = contentKinds();
        assertTrue(kinds.size() >= 5, "the contents record lost kinds: " + kinds);
        for (String kind : kinds) {
            if (!section.contains("<code>" + kind + "/</code>")) {
                missing.add(kind);
            }
        }
        assertEquals(List.of(), missing, "the contents section leaves out a kind of content");
        assertTrue(section.contains("<code>/&lt;playbook id&gt;:&lt;name&gt;</code>"),
                "the section never says how a command with a doubled name is invoked");
        assertTrue(section.contains("A playbook's hooks do not run"),
                "the section never says that nothing runs a playbook's hooks");
        assertFalse(section.contains("Copied to") || section.contains("playbook-hooks"),
                "the section still says that skills or hook scripts are copied");
    }

    @Test
    void theContentsSectionStatesThePromptCostAndThatAWorkflowFileMayNotRun() throws IOException {
        String section = contentsSection(chapter(rootOrSkip()));
        assertTrue(section.contains("characters"), "the section never mentions the prompt cost line");
        assertTrue(section.contains("is not run"), "the section never says that some workflow files are not run");
    }

    /**
     * Owner answer of 2026-10-13 (card 558): the server's install and remove
     * routes are gone, and so is every sentence that described them.
     */
    @Test
    void theChapterDescribesNoInstallOrRemoveOfThePlaybookContents() throws IOException {
        Path root = rootOrSkip();
        String part = chapter(root).replaceAll("\\s+", " ");
        String controller = Files.readString(root.resolve(
                "spectro-server/src/main/java/dev/spectroscope/server/playbooks/PlaybookController.java"));
        assertFalse(controller.contains("/api/playbooks/contents/install")
                || controller.contains("/api/playbooks/contents/remove"),
                "PlaybookController maps an install or remove route again; correct this test and the chapter");
        assertTrue(contentsSection(part).contains("the server has no route for either"),
                "the contents section does not say that nothing installs or removes a playbook's contents");
        for (String gone : List.of("answers an install request", "playbook-installs.json", "remove it first",
                "Remove takes out", "only through Install", "Import ZIP and Install", "It can install",
                "the install puts the working folder")) {
            assertFalse(part.contains(gone), "the chapter still describes the install or remove route: " + gone);
        }
    }

    @Test
    void theLimitsNoLongerSayThatContentsAreNotInstalled() throws IOException {
        String part = chapter(rootOrSkip());
        assertFalse(part.contains("are not installed into your"),
                "the limits still say a playbook's contents are not installed");
        assertFalse(part.contains("and that is all"),
                "the chapter still says the step table only reports installed skills");
        // Card 506: workflow step lists run; the limits now say what of them stays out.
        assertFalse(part.contains("no workflow runner"),
                "the chapter still says the product has no workflow runner");
        assertTrue(part.contains("A workflow file that is not a step list is listed and not run"),
                "the limits do not say what stays out: a workflow file that is not a step list");
    }

    /**
     * Card 558: the editor's Selection tab marks a step's skills from the
     * playbook folder, as the steps table does, in the table's own words.
     */
    @Test
    void theSelectionTabMarksASkillFromThePlaybookFolderInTheStepTablesWords() throws IOException {
        Path root = rootOrSkip();
        String part = chapter(root).replaceAll("\\s+", " ");
        String i18n = Files.readString(root.resolve(I18N));
        int from = part.indexOf("Selection edits the selected node");
        assertTrue(from >= 0, "the chapter no longer describes the Selection tab of the editor");
        String tab = part.substring(from, part.indexOf("</p>", from));
        for (String key : List.of("pb.run.skillPlaybook", "pb.run.skillMissing")) {
            String mark = english(i18n, key);
            assertTrue(tab.contains("&ldquo;" + mark + "&rdquo;"), "the Selection tab does not quote the mark: " + mark);
        }
        assertFalse(tab.contains("not installed"), "the Selection tab still marks a skill by whether it is installed");
    }

    /** Card 506: the section that describes a workflow file and its run. */
    private static String workflowSection(String chapter) {
        int from = chapter.indexOf("id=\"ch-playbooks-workflows\"");
        assertTrue(from >= 0, "the chapter has no workflow section (id ch-playbooks-workflows)");
        int next = chapter.indexOf("<h2 ", from + 10);
        return chapter.substring(from, next < 0 ? chapter.length() : next);
    }

    @Test
    void theWorkflowSectionDescribesTheStepKindsTheRunAndTheRunControl() throws IOException {
        Path root = rootOrSkip();
        String section = collapse(workflowSection(chapter(root)));
        List<String> missing = new ArrayList<>();
        for (String kind : new java.util.TreeSet<>(dev.spectroscope.core.playbook.WorkflowReader.KINDS)) {
            if (!section.contains("<code>" + kind + "</code>")) {
                missing.add(kind);
            }
        }
        assertEquals(List.of(), missing, "the workflow section leaves out step kinds the reader knows");
        for (String word : List.of("<code>max_rounds</code>", "<code>repeat_until</code>", "<code>{{input}}</code>",
                "<code>{{previous}}</code>", "<code>{{folder}}</code>", "<code>{{results}}</code>",
                "<code>spawn_agents</code>", "<code>wait_agents</code>", "<code>list_agents</code>",
                "<code>send_message</code>", "summariser")) {
            assertTrue(section.contains(word), "the workflow section never names " + word);
        }
        assertTrue(section.contains(String.valueOf(dev.spectroscope.core.playbook.WorkflowReader.MAX_ROUNDS_LIMIT)),
                "the workflow section does not state the round limit");
        String i18n = Files.readString(root.resolve(I18N));
        // Card 554: a workflow starts from the chat; the Steps tab lists it and says when it does not run.
        for (String key : List.of("wf.title", "wf.notRunnable")) {
            assertTrue(section.contains(quoted(i18n, key)), "the workflow section does not quote " + key);
        }
        for (String spelling : spellings("playbook-workflow")) {
            assertTrue(section.contains("<code>" + spelling + "</code>"),
                    "the workflow section does not name the chat command " + spelling);
        }
        assertFalse(section.contains("beside Run"), "the workflow section still has a Run button");
    }

    @Test
    void theWorkflowSectionStatesTheRunsCeilingsAndThatAWorkerDoesNotRunFromTheModule() throws IOException {
        // Card 506 fix round 2: a whole run has two ceilings, read at load, and a
        // workflow that starts a worker child is listed and not run.
        Path root = rootOrSkip();
        String section = collapse(workflowSection(chapter(root)));
        assertTrue(section.contains(dev.spectroscope.core.playbook.WorkflowReader.MAX_CHILD_RUNS + " helper runs"),
                "the workflow section does not state the ceiling on helper runs");
        assertTrue(section.contains(dev.spectroscope.core.playbook.WorkflowReader.MAX_STEP_RUNS + " step runs"),
                "the workflow section does not state the ceiling on step runs");
        assertTrue(section.contains("A workflow that starts a <code>worker</code> helper is listed and not run"),
                "the workflow section does not say that a worker workflow is not run from the module");
        assertFalse(section.contains("each with a role (explore or worker)"),
                "the workflow section still offers worker as a role the module runs");
    }

    @Test
    void bothBuiltEditionsCarryTheContentsSection() throws IOException {
        Path root = rootOrSkip();
        for (String name : EDITIONS) {
            String edition = Files.readString(root.resolve(name));
            assertTrue(edition.contains(INSTALL_ANCHOR),
                    name + " has no contents section: rebuild it (docs/guide-assets/"
                            + "build_user_guide.py, both themes, then the PDFs and --stamp)");
        }
    }

    private static String quoted(String i18n, String key) {
        return "&ldquo;" + english(i18n, key) + "&rdquo;";
    }

    private static String collapse(String s) {
        return s.replaceAll("\\s+", " ");
    }

    private static final Path WEB_CHAT = Path.of("docs/guide-assets/parts/04-web-chat.html");
    private static final Path SESSIONS = Path.of("docs/guide-assets/parts/07-sessions.html");
    private static final Path FLEET = Path.of("docs/guide-assets/parts/11b-fleet.html");
    private static final Path SURFACES = Path.of("spectro-web/src/state/surfaces.ts");
    private static final Path APP_HEADER = Path.of("spectro-web/src/components/AppHeader.tsx");

    @Test
    void theSpectrolyzrSectionDescribesOnePageWithTheSwitchInTheWordsTheWindowShows() throws IOException {
        Path root = rootOrSkip();
        String section = collapse(spectrolyzrSection(root));
        String i18n = Files.readString(root.resolve(I18N));
        List<String> missing = new ArrayList<>();
        for (String key : List.of("lyzr.tab", "lyzr.kind", "lyzr.kind.project", "lyzr.kind.playbook",
                "lyzr.folders", "lyzr.tree", "lyzr.why", "lyzr.generate", "lyzr.pick", "pick.choose", "lyzr.models",
                "lyzr.model.keep")) {
            if (!section.contains(quoted(i18n, key))) {
                missing.add(key + " = \"" + english(i18n, key) + "\"");
            }
        }
        assertEquals(List.of(), missing,
                "the Spectrolyzr section does not quote, in &ldquo; and &rdquo;, the English text the page shows for these keys");
        assertTrue(section.contains("one page"), "the section never says that Spectrolyzr is one page");
        assertTrue(section.contains("No project is written"),
                "the section never says that a new playbook writes no project");
        assertTrue(section.contains("copy of the shipped spectro playbook"),
                "the section never says that a new playbook is a copy of the shipped pack");
        for (String stale : List.of("three steps", "The wizard", "&ldquo;New project&rdquo;",
                "<b>Review.</b>", "Next&rdquo;")) {
            assertFalse(section.contains(stale), "the section still describes the three step wizard: " + stale);
        }
    }

    @Test
    void theSpectrolyzrSectionNamesTheFourModelRolesAndWhereTheNewPlaybookIsListed() throws IOException {
        Path root = rootOrSkip();
        String section = collapse(spectrolyzrSection(root));
        List<String> missing = new ArrayList<>();
        playbook(root).get("models").fieldNames().forEachRemaining(k -> {
            if (!section.contains("<code>" + k + "</code>")) {
                missing.add(k);
            }
        });
        assertEquals(List.of(), missing, "the section leaves out model roles of the shipped playbook");
        assertTrue(section.contains("contents row"),
                "the section never says where the workflows of the new playbook are listed");
        // Card 506: the shipped playbook declares workflows, and the section names each one.
        List<String> unnamed = new ArrayList<>();
        playbook(root).get("contents").get("workflows").forEach(w -> {
            String name = w.asText().substring(w.asText().lastIndexOf('/') + 1);
            if (!section.contains("<code>" + name + "</code>")) {
                unnamed.add(name);
            }
        });
        assertFalse(playbook(root).get("contents").get("workflows").isEmpty(), "premise: the pack ships workflows");
        assertEquals(List.of(), unnamed, "the section leaves out workflows the shipped playbook declares");
        assertFalse(section.contains("declares no workflows"),
                "the section still says that the shipped playbook declares no workflows");
    }

    @Test
    void theChapterDescribesTheChooseButtonOnEveryFolderFieldAndItsTwoNotes() throws IOException {
        Path root = rootOrSkip();
        String part = collapse(chapter(root));
        String i18n = Files.readString(root.resolve(I18N));
        for (String key : List.of("pick.busy", "pick.paste")) {
            assertTrue(part.contains(quoted(i18n, key)),
                    "the chapter does not quote the note the window shows for " + key);
        }
        String segment = part.substring(part.indexOf("id=\"ch-playbooks-mode\""));
        segment = segment.substring(0, segment.indexOf("<h2 ", 10));
        assertTrue(segment.contains(quoted(i18n, "pick.choose")),
                "the Folders part of the segment never names the Choose button");
    }

    @Test
    void theModeChapterSaysDeveloperHidesTheTabRowUntilTheTutorialIsOnAndTheTableAgrees() throws IOException {
        Path root = rootOrSkip();
        String table = Files.readString(root.resolve(SURFACES));
        assertTrue(table.contains("tabRow: { modes: { learn: \"open\", light: \"tutorial\", developer: \"tutorial\" } }"),
                "the surface table no longer hides the tab row in developer: correct this test and the mode chapter");
        String modes = collapse(Files.readString(root.resolve(MODES)));
        assertTrue(modes.contains("In developer and in light the row of tabs above the chat is drawn only while the tutorial is on"),
                "the mode chapter never says that developer shares light's rule for the row of tabs");
        assertTrue(modes.contains("a fresh developer window opens on the chat alone"),
                "the mode chapter never says that a fresh developer window shows the chat alone");
    }

    @Test
    void backAndForwardStandLeftOfTheModeSwitchAndTheGuideSaysSoEverywhere() throws IOException {
        Path root = rootOrSkip();
        String header = Files.readString(root.resolve(APP_HEADER));
        assertTrue(header.indexOf("<NavSteps") > 0 && header.indexOf("<NavSteps") < header.indexOf("<ModeSwitch"),
                "the header no longer draws back and forward left of the mode switch");
        String chat = collapse(Files.readString(root.resolve(WEB_CHAT)));
        assertTrue(chat.contains("the back and forward buttons, left of the mode switch"),
                "the header description never names back and forward left of the mode switch");
        String sessions = collapse(Files.readString(root.resolve(SESSIONS)));
        assertFalse(sessions.contains("The tab row draws its own back"),
                "the sessions chapter still puts back and forward in the tab row");
        assertTrue(sessions.contains("The header draws back and forward chevrons"),
                "the sessions chapter never says that the header draws back and forward");
        String fleet = collapse(Files.readString(root.resolve(FLEET)));
        assertFalse(fleet.contains("chevrons are absent here"),
                "the fleet chapter still says the chevrons are absent while a fleet is entered");
    }

    @Test
    void bothBuiltEditionsCarryTheOnePageTheHeaderPairAndTheDeveloperRule() throws IOException {
        Path root = rootOrSkip();
        for (String name : EDITIONS) {
            String edition = collapse(Files.readString(root.resolve(name)));
            for (String needle : List.of("&ldquo;What to make&rdquo;", "No project is written",
                    "the back and forward buttons, left of the mode switch",
                    "a fresh developer window opens on the chat alone",
                    "The header draws back and forward chevrons")) {
                assertTrue(edition.contains(needle),
                        name + " lacks \"" + needle + "\": rebuild it (docs/guide-assets/build_user_guide.py, "
                                + "both themes, then the PDFs and --stamp)");
            }
            assertFalse(edition.contains("chevrons are absent here"), name + " carries the old fleet sentence");
        }
    }
}
