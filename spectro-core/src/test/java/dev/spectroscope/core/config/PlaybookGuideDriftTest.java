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

    @Test
    void theInstallSectionNamesEveryKindAndWhatEachBecomes() throws IOException {
        String section = installSection(chapter(rootOrSkip()));
        List<String> missing = new ArrayList<>();
        for (String kind : List.of("skills", "commands", "hooks", "agents", "workflows")) {
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
