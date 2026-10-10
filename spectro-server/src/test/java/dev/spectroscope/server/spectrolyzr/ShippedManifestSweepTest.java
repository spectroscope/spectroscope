package dev.spectroscope.server.spectrolyzr;

import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookValidator;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Every combination of the shipped manifest: three archetypes, three
 * languages and the eight add-on subsets. Each renders twice to the same
 * bytes, puts no path twice, carries a Why sentence in both languages, leaks
 * no machine path or placeholder, and with the spectro playbook add-on holds
 * a playbook that reads and validates clean with {@code vars.test} set to the
 * project's check command.
 */
class ShippedManifestSweepTest {

    private static final String PLAYBOOK = "spectro-playbook";
    private static final String PLAYBOOK_SECTION = "## Playbook";

    private static Manifest shipped() {
        ManifestReader.Read read = ManifestReader.read("spectrolyzr");
        assertEquals(List.of(), read.problems(), "the shipped manifest must be clean");
        assertNotNull(read.manifest());
        return read.manifest();
    }

    private static RenderedFile file(List<RenderedFile> files, String root, String path) {
        return files.stream().filter(f -> f.root().equals(root) && f.path().equals(path)).findFirst()
                .orElseThrow(() -> new AssertionError("no " + root + ":" + path + " in "
                        + files.stream().map(f -> f.root() + ":" + f.path()).toList()));
    }

    @Test
    void everyCombinationRendersTwiceToTheSameBytesAndHoldsTheRules() throws Exception {
        Manifest m = shipped();
        assertEquals(List.of(), Spectrolyzr.validateAll(m));
        String host = java.net.InetAddress.getLocalHost().getHostName();
        int combinations = 0;
        int withPlaybook = 0;
        for (var a : m.archetypes()) {
            for (var l : m.languages()) {
                for (List<String> addons : Spectrolyzr.addonSubsets(m)) {
                    combinations++;
                    Choices c = new Choices(a.id(), l.id(), addons, "ledger-api");
                    List<RenderedFile> one = Spectrolyzr.render(m, c);
                    List<RenderedFile> two = Spectrolyzr.render(m, c);
                    assertEquals(one, two, c.toString());
                    Set<String> seen = new HashSet<>();
                    for (RenderedFile f : one) {
                        assertTrue(seen.add(f.root() + ":" + f.path()), "twice: " + f.path() + " in " + c);
                        assertFalse(f.why().en().isBlank() || f.why().de().isBlank(), "why missing: " + f.path());
                        for (String s : List.of(f.content(), f.why().en(), f.why().de())) {
                            assertFalse(s.contains("/Users/") || s.contains("/home/") || s.contains(host),
                                    "machine path in " + f.path() + " of " + c);
                            assertFalse(s.matches("(?s).*@@[a-z_]+@@.*"), "placeholder left in " + f.path() + " of " + c);
                        }
                        // Dashes: our templates and every Why sentence. Imported P2 files are held by P2's own tests.
                        for (String s : f.root().equals("project") ? List.of(f.content(), f.why().en(), f.why().de())
                                : List.of(f.why().en(), f.why().de())) {
                            assertFalse(s.indexOf(0x2014) >= 0 || s.indexOf(0x2013) >= 0, "dash in " + f.path() + " of " + c);
                        }
                    }
                    if (addons.contains(PLAYBOOK)) {
                        withPlaybook++;
                        String json = file(one, "playbook", "playbook.json").content();
                        var read = PlaybookReader.read(json);
                        assertEquals(List.of(), read.findings(), c.toString());
                        assertEquals(List.of(), PlaybookValidator.validate(read.playbook()), c.toString());
                        String check = addons.contains("quality-gate") ? l.commands().get("gate") : l.commands().get("test");
                        assertEquals(check, read.playbook().vars().get("test"), c.toString());
                    } else {
                        assertFalse(one.stream().anyMatch(f -> !f.root().equals("project")),
                                "no playbook root without the add-on: " + c);
                    }
                }
            }
        }
        assertEquals(72, combinations);
        assertEquals(36, withPlaybook);
    }

    @Test
    void thePlaybookFolderHoldsTheWholeBundleWithTheDocumentationPage() {
        Manifest m = shipped();
        List<RenderedFile> files = Spectrolyzr.render(m, new Choices("service", "java", List.of(PLAYBOOK), "ledger-api"));
        List<String> playbook = files.stream().filter(f -> f.root().equals("playbook")).map(RenderedFile::path).toList();
        assertEquals(playbook.stream().sorted().toList(), playbook, "the imported paths are sorted");
        for (String path : List.of("playbook.json", "LICENSE", "PROVENANCE.md", "docs/index.html",
                "skills/spectropowers/brainstorming/SKILL.md", "templates/spec.md")) {
            assertTrue(playbook.contains(path), path + " in " + playbook);
        }
        String page = file(files, "playbook", "docs/index.html").content();
        assertTrue(page.contains("spectro"), "the page names the playbook id");
        assertTrue(page.contains("brainstorm"), "the page names the step brainstorm");
        // The page is copied as bundled. If it ever renders vars, the copy would show the bundle's
        // test command and not the project's, and the add-on would have to regenerate the page.
        assertFalse(page.contains("./gradlew test --rerun-tasks --no-build-cache"), "the page renders no vars");
    }

    @Test
    void theProjectClaudeMdNamesThePlaybookAndNoPath() {
        Manifest m = shipped();
        for (var l : m.languages()) {
            for (List<String> addons : List.of(List.of(PLAYBOOK), List.of("quality-gate", PLAYBOOK))) {
                Choices c = new Choices("library", l.id(), addons, "ledger-api");
                String claude = file(Spectrolyzr.render(m, c), "project", "CLAUDE.md").content();
                int at = claude.lastIndexOf(PLAYBOOK_SECTION);
                assertTrue(at > 0, "a playbook section in " + c);
                assertEquals(-1, claude.indexOf("\n## ", at + 1), "the playbook section comes last in " + c);
                String section = claude.substring(at);
                assertTrue(section.contains("`spectro`"), "the section names the playbook id: " + c);
                assertFalse(section.contains("/") || section.contains("\\") || section.contains("~"),
                        "the section writes no path: " + c);
                assertFalse(claude.contains("ledger-api-playbook"), "no playbook folder name: " + c);
                assertTrue(claude.endsWith("\n"), c.toString());
            }
            String without = file(Spectrolyzr.render(m, new Choices("library", l.id(), List.of(), "ledger-api")),
                    "project", "CLAUDE.md").content();
            assertFalse(without.contains(PLAYBOOK_SECTION), l.id() + " without the add-on has no playbook section");
        }
    }
}
