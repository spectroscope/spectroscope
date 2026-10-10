package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookValidator;
import dev.spectroscope.core.playbook.PlaybookWriter;
import dev.spectroscope.core.playbook.run.PlaybookWalk;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The shipped playbook is valid, licensed, provenanced and carries the house rules. */
class SpectroPlaybookTest {

    static final String BUNDLE = "bundled-playbooks/spectro/";
    static final String SKILLS = BUNDLE + "skills/spectropowers/";
    static final String CATALOGUE = "skills-catalogue/superpowers/";

    private static String resource(String path) throws IOException {
        return new ClassPathResource(BUNDLE + path).getContentAsString(StandardCharsets.UTF_8);
    }

    /** Every file under a classpath folder, keyed by its path below that folder. */
    static Map<String, Resource> filesUnder(String folder) throws IOException {
        Map<String, Resource> out = new TreeMap<>();
        for (Resource r : new PathMatchingResourcePatternResolver().getResources("classpath*:" + folder + "**")) {
            if (!r.isReadable()) {
                continue;
            }
            String url = r.getURL().toString();
            int at = url.lastIndexOf(folder);
            if (at >= 0 && !url.endsWith("/")) {
                out.put(url.substring(at + folder.length()), r);
            }
        }
        return out;
    }

    static TreeSet<String> topFolders(Map<String, Resource> files) {
        TreeSet<String> out = new TreeSet<>();
        for (String path : files.keySet()) {
            if (path.contains("/")) {
                out.add(path.substring(0, path.indexOf('/')));
            }
        }
        return out;
    }

    @Test
    void theShippedPlaybookReadsAndValidatesClean() throws IOException {
        PlaybookReader.Read read = PlaybookReader.read(resource("playbook.json"));
        assertEquals(List.of(), read.findings());
        List<Finding> findings = PlaybookValidator.validate(read.playbook());
        assertEquals(List.of(), findings, findings.toString());
        Playbook p = read.playbook();
        assertEquals("spectro", p.id());
        assertTrue(p.models().keySet().containsAll(List.of("fast", "standard", "strong", "judge")));
        assertTrue(p.documents().keySet().containsAll(List.of("ticket", "spec", "plan", "task_report", "review_report")));
    }

    @Test
    void theShippedLoopsCountTheirRoundsPerTask() throws IOException {
        Playbook p = PlaybookReader.read(resource("playbook.json")).playbook();
        List<String> rounds = new ArrayList<>();
        List<String> exits = new ArrayList<>();
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Decision d && d.maxRounds() != null) {
                for (Playbook.Arrow a : PlaybookWalk.arrowsFrom(p, d.id())) {
                    (PlaybookWalk.isRound(p, d.id(), a.to()) ? rounds : exits).add(d.id() + " " + a.on());
                }
            }
        }
        assertEquals(List.of("spec_ok fail", "plan_ok fail", "review_task fail", "final_review fail"), rounds,
                "only a fail that goes back to fix counts a round");
        assertEquals(List.of("spec_ok pass", "spec_ok exhausted", "plan_ok pass", "plan_ok exhausted",
                "review_task pass", "review_task exhausted", "final_review pass", "final_review exhausted"), exits,
                "a passed task review leaves its loop, so the next task's reviews start at zero");
    }

    @Test
    void theShippedPlaybookIsStoredInTheCanonicalForm() throws IOException {
        String file = resource("playbook.json");
        assertEquals(file, PlaybookWriter.write(PlaybookReader.read(file).playbook()));
    }

    @Test
    void theShippedBundleCopiedIntoAFolderLoadsWithoutFindings(@TempDir Path tmp) throws IOException {
        Map<String, Resource> files = new PlaybookController(new PlaybookFolders(tmp.resolve("playbooks.json")),
                PlaybookController.BUNDLE_ROOT).bundled("spectro");
        assertTrue(files.containsKey("playbook.json"), files.keySet().toString());
        Path dir = tmp.resolve("spectro");
        for (Map.Entry<String, Resource> f : files.entrySet()) {
            Path target = dir.resolve(f.getKey());
            Files.createDirectories(target.getParent());
            try (InputStream in = f.getValue().getInputStream()) {
                Files.copy(in, target);
            }
        }
        Path ws = Files.createDirectories(tmp.resolve("ws"));
        PlaybookLoader.Loaded loaded = PlaybookLoader.load(dir, ws, SpectroConfig.load(SpectroConfig.Overrides.none()));
        assertEquals(List.of(), loaded.findings(), loaded.findings().toString());
    }

    @Test
    void everyTemplateCarriesTheSectionsOfItsDocumentTypeAsHeadings() throws IOException {
        Playbook p = PlaybookReader.read(resource("playbook.json")).playbook();
        assertEquals(5, p.documents().size());
        for (Map.Entry<String, Playbook.DocumentType> d : p.documents().entrySet()) {
            List<String> headings = new ArrayList<>();
            for (String line : resource(d.getValue().template()).split("\n")) {
                if (line.startsWith("## ")) {
                    headings.add(line.substring(3).strip());
                }
            }
            assertEquals(d.getValue().sections(), headings, d.getKey() + " template headings");
        }
    }

    @Test
    void everyStepNamesASpectropowersSkillThatShipsInTheBundle() throws IOException {
        Playbook p = PlaybookReader.read(resource("playbook.json")).playbook();
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Step s) {
                for (String skill : s.skills()) {
                    assertTrue(skill.startsWith("spectropowers:"), s.id() + " names " + skill);
                    String folder = skill.substring("spectropowers:".length());
                    assertTrue(new ClassPathResource(SKILLS + folder + "/SKILL.md").exists(),
                            s.id() + " names a skill that does not ship: " + skill);
                }
            }
        }
    }

    @Test
    void theFourteenSkillFoldersOfTheCatalogueShipUnderTheirOwnNames() throws IOException {
        TreeSet<String> expected = new TreeSet<>();
        for (String folder : topFolders(filesUnder(CATALOGUE + "skills/"))) {
            expected.add(folder.equals("using-superpowers") ? "using-spectropowers" : folder);
        }
        assertEquals(14, expected.size(), expected.toString());
        assertEquals(expected, topFolders(filesUnder(SKILLS)));
    }

    @Test
    void licenceAndProvenanceTravelWithTheCopy() throws IOException {
        assertArrayEquals(new ClassPathResource(CATALOGUE + "LICENSE").getContentAsByteArray(),
                new ClassPathResource(BUNDLE + "LICENSE").getContentAsByteArray());
        assertTrue(resource("LICENSE").startsWith("MIT License"));
        String provenance = resource("PROVENANCE.md");
        assertTrue(provenance.contains("https://github.com/obra/superpowers"));
        assertTrue(provenance.contains("b36e0829c6d0140e93cfef2ca599b1b07d4a7797"));
        assertTrue(provenance.contains("6.3.0"));
        for (String skill : topFolders(filesUnder(SKILLS))) {
            assertTrue(provenance.contains(skill), "provenance names " + skill);
        }
        for (String edited : EDITED) {
            assertTrue(provenance.contains("`" + edited + "`"), "provenance names the edited file " + edited);
        }
    }

    @Test
    void everyFileThatDiffersFromItsSourceIsNamedInTheProvenance() throws IOException {
        String provenance = resource("PROVENANCE.md");
        Map<String, Resource> source = filesUnder(CATALOGUE + "skills/");
        int differing = 0;
        for (Map.Entry<String, Resource> f : filesUnder(SKILLS).entrySet()) {
            String sourcePath = f.getKey().startsWith("using-spectropowers/")
                    ? "using-superpowers/" + f.getKey().substring("using-spectropowers/".length()) : f.getKey();
            Resource src = source.get(sourcePath);
            assertTrue(src != null, f.getKey() + " has no source in the catalogue");
            if (!java.util.Arrays.equals(src.getContentAsByteArray(), f.getValue().getContentAsByteArray())) {
                differing++;
                assertTrue(provenance.contains("| `" + f.getKey() + "` |"), "provenance names the changed file " + f.getKey());
            }
        }
        assertTrue(differing >= EDITED.size(), "the house rule edits differ from the source: " + differing);
    }

    /** The files the nine house rule edits touch, each named in the provenance. */
    static final List<String> EDITED = List.of(
            "brainstorming/SKILL.md", "writing-plans/SKILL.md", "subagent-driven-development/SKILL.md",
            "executing-plans/SKILL.md", "test-driven-development/writing-good-tests.md",
            "test-driven-development/SKILL.md", "verification-before-completion/SKILL.md",
            "finishing-a-development-branch/SKILL.md", "requesting-code-review/SKILL.md",
            "using-spectropowers/SKILL.md");

    /** One marker sentence per house rule change (spec table), each tested as present. */
    static final Map<String, String> MARKERS = Map.of(
            "brainstorming", "chris-criticism",
            "writing-plans", "explicit staging paths",
            "subagent-driven-development", "stop and ask the owner",
            "executing-plans", "TASKS.md",
            "test-driven-development", "commit first, break the implementation",
            "verification-before-completion", "never through a pipe",
            "finishing-a-development-branch", "--no-ff",
            "requesting-code-review", "merge base",
            "using-spectropowers", "User instructions");

    @Test
    void theHouseRulesArePresentInTheRewrittenSkills() throws IOException {
        for (Map.Entry<String, String> e : MARKERS.entrySet()) {
            String text = resource("skills/spectropowers/" + e.getKey() + "/SKILL.md");
            assertTrue(text.contains(e.getValue()), e.getKey() + " lacks the marker: " + e.getValue());
        }
        assertTrue(resource("skills/spectropowers/test-driven-development/writing-good-tests.md")
                .contains("commit first, break the implementation"), "writing-good-tests lacks the real mutation probe");
        String using = resource("skills/spectropowers/using-spectropowers/SKILL.md");
        assertTrue(using.indexOf("User instructions") < using.indexOf("<SUBAGENT-STOP>"),
                "using-spectropowers states the user instruction rule first");
    }

    @Test
    void noShippedFileStillNamesASuperpowersSkill() throws IOException {
        Map<String, Resource> files = filesUnder(SKILLS);
        assertTrue(files.size() > 14, "the skills are on the classpath: " + files.size());
        for (Map.Entry<String, Resource> f : files.entrySet()) {
            String text = f.getValue().getContentAsString(StandardCharsets.UTF_8);
            assertFalse(text.contains("superpowers:"), f.getKey() + " still references a superpowers: skill name");
            assertFalse(text.contains("using-superpowers"), f.getKey() + " still names using-superpowers");
        }
    }

    static final Pattern SPACED_HYPHEN = Pattern.compile("(?<=\\S) - (?=\\S)");
    static final Pattern INLINE_CODE = Pattern.compile("`[^`]*`");
    static final Pattern LIST_MARKER = Pattern.compile("^\\s*([-*]|\\d+\\.)\\s+");

    /** Spaced hyphens used as dashes in Markdown prose: outside code fences and inline code, list markers aside. */
    static List<String> spacedHyphens(String markdown) {
        List<String> out = new ArrayList<>();
        boolean fence = false;
        for (String line : markdown.split("\n", -1)) {
            if (line.stripLeading().startsWith("```")) {
                fence = !fence;
                continue;
            }
            if (fence) {
                continue;
            }
            String prose = LIST_MARKER.matcher(INLINE_CODE.matcher(line).replaceAll("code")).replaceFirst("");
            Matcher m = SPACED_HYPHEN.matcher(prose);
            if (m.find()) {
                out.add(line);
            }
        }
        return out;
    }

    @Test
    void noDashAsPunctuationInTheShippedSkills() throws IOException {
        Map<String, Resource> files = filesUnder(SKILLS);
        assertTrue(files.size() > 14, "the skills are on the classpath: " + files.size());
        for (Map.Entry<String, Resource> f : files.entrySet()) {
            String text = f.getValue().getContentAsString(StandardCharsets.UTF_8);
            assertTrue(!text.contains("—") && !text.contains("–"), f.getKey() + " carries a dash");
            if (f.getKey().endsWith(".md")) {
                assertEquals(List.of(), spacedHyphens(text), f.getKey() + " uses a spaced hyphen as a dash");
            }
        }
    }

    @Test
    void theSpacedHyphenProbeSeesADashAndPassesCodeAndListMarkers() {
        assertEquals(1, spacedHyphens("plans - ensures a workspace").size());
        assertEquals(1, spacedHyphens("**Fast:** `poll(1)` - wastes CPU").size());
        assertEquals(List.of(), spacedHyphens("- a list item\n`a - b` in code\n```\nx - y\n```\n1. item"));
    }
}
