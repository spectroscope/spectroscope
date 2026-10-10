package dev.spectroscope.server.spectrolyzr;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SpectrolyzrRenderTest {

    static final Manifest FIXTURE = ManifestReader.read("spectrolyzr-fixture").manifest();

    private static RenderedFile file(List<RenderedFile> files, String root, String path) {
        return files.stream().filter(f -> f.root().equals(root) && f.path().equals(path)).findFirst()
                .orElseThrow(() -> new AssertionError("no " + root + ":" + path + " in " + files));
    }

    @Test
    void rendersPlaceholdersInPathsAndContentInManifestOrder() {
        List<RenderedFile> files = Spectrolyzr.render(FIXTURE, new Choices("a", "py", List.of(), "ledger-api"));
        assertEquals(List.of("README.md", "ledger_api/x.py"), files.stream().map(RenderedFile::path).toList());
        assertEquals("# ledger-api\nrun: T\n", file(files, "project", "README.md").content());
        assertEquals("NAME = \"ledger-api\"\n", file(files, "project", "ledger_api/x.py").content());
    }

    @Test
    void theQualityGateMakesTheGateTheCheckCommandAndAppendsInPlace() {
        List<RenderedFile> files = Spectrolyzr.render(FIXTURE, new Choices("a", "py", List.of("quality-gate"), "n"));
        assertEquals("# n\nrun: G\ngate section\n", file(files, "project", "README.md").content());
        assertEquals("README.md", files.get(0).path(), "an append keeps the file's position");
    }

    @Test
    void addonsApplyInManifestOrderNotInClickOrder() {
        var a = Spectrolyzr.render(FIXTURE, new Choices("a", "py", List.of("quality-gate", "pb"), "n"));
        var b = Spectrolyzr.render(FIXTURE, new Choices("a", "py", List.of("pb", "quality-gate"), "n"));
        assertEquals(a, b);
    }

    @Test
    void theImportIsSortedAndItsJsonPointerIsSet() throws Exception {
        List<RenderedFile> files = Spectrolyzr.render(FIXTURE, new Choices("a", "py", List.of("quality-gate", "pb"), "n"));
        List<String> playbook = files.stream().filter(f -> f.root().equals("playbook")).map(RenderedFile::path).toList();
        assertEquals(List.of("playbook.json", "skills/s/SKILL.md"), playbook);
        String json = file(files, "playbook", "playbook.json").content();
        assertEquals("G", new com.fasterxml.jackson.databind.ObjectMapper().readTree(json).at("/vars/test").asText(), json);
    }

    @Test
    void unknownChoicesAndBadNamesAreRefusedWithTheirField() {
        assertEquals("archetype", assertThrows(ChoiceException.class,
                () -> Spectrolyzr.render(FIXTURE, new Choices("x", "py", List.of(), "n"))).field());
        assertEquals("language", assertThrows(ChoiceException.class,
                () -> Spectrolyzr.render(FIXTURE, new Choices("a", "typescript", List.of(), "n"))).field());
        assertEquals("addons", assertThrows(ChoiceException.class,
                () -> Spectrolyzr.render(FIXTURE, new Choices("a", "py", List.of("lint"), "n"))).field());
        for (String bad : List.of("", "Ledger", "-a", "a-", "a--b", "a/b", "../a", "a".repeat(41))) {
            assertEquals("name", assertThrows(ChoiceException.class,
                    () -> Spectrolyzr.render(FIXTURE, new Choices("a", "py", List.of(), bad))).field(), bad);
        }
    }

    @Test
    void aNameWhoseIdentifierIsAKeywordIsRefused() {
        assertEquals("name", assertThrows(ChoiceException.class,
                () -> Spectrolyzr.render(FIXTURE, new Choices("a", "py", List.of(), "class"))).field());
        assertEquals("name", assertThrows(ChoiceException.class,
                () -> Spectrolyzr.render(FIXTURE, new Choices("a", "py", List.of(), "lambda"))).field());
    }

    @Test
    void twoRendersAreByteIdentical() {
        for (List<String> addons : Spectrolyzr.addonSubsets(FIXTURE)) {
            var one = Spectrolyzr.render(FIXTURE, new Choices("a", "py", addons, "n"));
            var two = Spectrolyzr.render(FIXTURE, new Choices("a", "py", addons, "n"));
            assertEquals(one.size(), two.size());
            for (int i = 0; i < one.size(); i++) {
                assertArrayEquals(one.get(i).content().getBytes(StandardCharsets.UTF_8),
                        two.get(i).content().getBytes(StandardCharsets.UTF_8), one.get(i).path());
            }
        }
    }

    @Test
    void theAddonSubsetsAreEveryCombinationInManifestOrderEmptyFirst() {
        assertEquals(List.of(List.of(), List.of("quality-gate"), List.of("pb"), List.of("quality-gate", "pb")),
                Spectrolyzr.addonSubsets(FIXTURE));
    }

    @Test
    void theImportedPlaybookDiffersFromTheBundleByTheOneVarsLine() throws Exception {
        String bundled;
        try (var in = getClass().getClassLoader().getResourceAsStream("spectrolyzr-fixture/bundle/playbook.json")) {
            bundled = new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
        String written = file(Spectrolyzr.render(FIXTURE, new Choices("a", "py", List.of("pb"), "n")),
                "playbook", "playbook.json").content();
        List<String> a = bundled.lines().toList();
        List<String> b = written.lines().toList();
        assertEquals(a.size(), b.size(), written);
        int differing = 0;
        for (int i = 0; i < a.size(); i++) {
            if (!a.get(i).equals(b.get(i))) {
                differing++;
                assertEquals("    \"test\": \"T\"", b.get(i));
            }
        }
        assertEquals(1, differing, written);
        assertTrue(written.endsWith("}\n"));
    }
}
