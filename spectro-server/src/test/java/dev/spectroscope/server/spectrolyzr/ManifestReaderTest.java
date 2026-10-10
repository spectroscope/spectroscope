package dev.spectroscope.server.spectrolyzr;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class ManifestReaderTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String ROOT = "spectrolyzr-fixture";

    private static ObjectNode fixture() throws IOException {
        try (var in = ManifestReaderTest.class.getClassLoader().getResourceAsStream(ROOT + "/manifest.json")) {
            return (ObjectNode) JSON.readTree(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    private static List<String> problemsAfter(Consumer<ObjectNode> edit) throws IOException {
        ObjectNode tree = fixture();
        edit.accept(tree);
        ManifestReader.Read read = ManifestReader.parse(JSON.writeValueAsString(tree), ROOT);
        assertNull(read.manifest(), "a manifest with problems is not handed out");
        assertTrue(!read.problems().isEmpty(), "the edit must produce a problem");
        return read.problems();
    }

    private static void assertNamed(List<String> problems, String... fragments) {
        assertTrue(problems.stream().anyMatch(p -> Arrays.stream(fragments).allMatch(p::contains)),
                "no problem names " + Arrays.toString(fragments) + " in " + problems);
    }

    private static ObjectNode part(ObjectNode tree, int i) {
        return (ObjectNode) tree.withArray("parts").get(i);
    }

    private static ObjectNode put(ObjectNode tree, int part, int i) {
        return (ObjectNode) part(tree, part).withArray("put").get(i);
    }

    @Test
    void theFixtureReadsCleanAndValidatesClean() {
        ManifestReader.Read read = ManifestReader.read(ROOT);
        assertEquals(List.of(), read.problems());
        assertNotNull(read.manifest());
        assertEquals(List.of(), Spectrolyzr.validateAll(read.manifest()));
        assertEquals(ROOT, read.manifest().resourceRoot());
        assertEquals(3, read.manifest().parts().size());
        assertEquals("spectrolyzr-fixture/bundle/", read.manifest().parts().get(2).importFrom().from());
    }

    @Test
    void aMissingManifestIsAProblem() {
        ManifestReader.Read read = ManifestReader.read("no-such-root");
        assertNull(read.manifest());
        assertNamed(read.problems(), "no-such-root/manifest.json");
    }

    @Test
    void anUnknownFieldIsAProblemNamingItsPath() throws IOException {
        assertNamed(problemsAfter(t -> put(t, 0, 1).put("mode", "x")), "parts[0].put[1].mode", "unknown field");
        assertNamed(problemsAfter(t -> t.put("extra", 1)), "extra", "unknown field");
    }

    @Test
    void anUnknownPlaceholderIsAProblemNamingTheTemplate() throws IOException {
        assertNamed(problemsAfter(t -> put(t, 0, 1).put("template", "base/bad.tmpl")), "base/bad.tmpl", "@@nme@@");
    }

    @Test
    void aMissingTemplateIsAProblem() throws IOException {
        assertNamed(problemsAfter(t -> put(t, 0, 1).put("template", "base/none.tmpl")), "base/none.tmpl");
    }

    @Test
    void aTemplateWithACarriageReturnIsAProblem() throws IOException {
        assertNamed(problemsAfter(t -> put(t, 0, 1).put("template", "base/crlf.tmpl")), "base/crlf.tmpl",
                "carriage return");
    }

    @Test
    void twoPartsPuttingOnePathInOneCombinationIsAProblem() throws IOException {
        assertNamed(problemsAfter(t -> put(t, 1, 0).put("path", "README.md")), "README.md", "addons=[quality-gate]",
                "archetype=a", "language=py");
    }

    @Test
    void anAppendToAPathNoEarlierPartPutIsAProblem() throws IOException {
        assertNamed(problemsAfter(t -> ((ObjectNode) part(t, 1).withArray("append").get(0)).put("path", "NOTES.md")),
                "NOTES.md", "append");
    }

    @Test
    void setJsonOnAnotherFileIsAProblemNamingThePart() throws IOException {
        assertNamed(problemsAfter(t -> ((ObjectNode) part(t, 2).with("import").with("set_json"))
                .set("skills/s/SKILL.md", JSON.createObjectNode().put("/x", "y"))), "pb", "set_json",
                "skills/s/SKILL.md");
    }

    @Test
    void aPutWithoutAGermanWhyIsAProblem() throws IOException {
        assertNamed(problemsAfter(t -> put(t, 0, 0).with("why").remove("de")), "parts[0].put[0].why.de");
    }

    @Test
    void aPathWithADotDotSegmentIsAProblem() throws IOException {
        assertNamed(problemsAfter(t -> put(t, 0, 1).put("path", "../x.py")), "../x.py");
        assertNamed(problemsAfter(t -> put(t, 0, 1).put("path", "/x.py")), "/x.py");
    }

    @Test
    void anImportedFileNoWhyRuleMatchesIsAProblem() throws IOException {
        assertNamed(problemsAfter(t -> ((ArrayNode) part(t, 2).with("import").withArray("why_by_prefix")).remove(1)),
                "skills/s/SKILL.md", "why");
    }

    @Test
    void aWhyWithADashIsAProblem() throws IOException {
        assertNamed(problemsAfter(t -> put(t, 0, 0).with("why").put("en", "Says what — the project is.")),
                "parts[0].put[0].why.en", "dash");
        assertNamed(problemsAfter(t -> put(t, 0, 0).with("why").put("de", "Sagt, was – das Projekt ist.")),
                "parts[0].put[0].why.de", "dash");
    }

    @Test
    void aWhenNamingAnUnknownIdIsAProblem() throws IOException {
        assertNamed(problemsAfter(t -> part(t, 1).with("when").put("addon", "lint")), "lint");
    }

    /**
     * JLS 21 section 3.9, ReservedKeyword, plus the literals true, false and
     * null (section 3.10.3 and 3.10.8), copied from
     * https://docs.oracle.com/javase/specs/jls/se21/html/jls-3.html#jls-3.9 on 2026-10-10.
     */
    private static final String JLS_21_KEYWORDS = "abstract continue for new switch assert default if package "
            + "synchronized boolean do goto private this break double implements protected throw byte else import "
            + "public throws case enum instanceof return transient catch extends int short try char final interface "
            + "static void class finally long strictfp volatile const float native super while _ true false null";

    @Test
    void theJavaKeywordsAreTheJlsList() {
        assertEquals(List.of(JLS_21_KEYWORDS.split(" ")).stream().sorted().toList(),
                Spectrolyzr.JAVA_KEYWORDS.stream().sorted().toList());
    }

    @Test
    void thePythonKeywordsAreThePythonList() throws Exception {
        Process p;
        try {
            p = new ProcessBuilder("python3", "-c", "import keyword;print(' '.join(keyword.kwlist))")
                    .redirectErrorStream(true).start();
        } catch (IOException absent) {
            assumeTrue(false, "python3 is not on this machine");
            return;
        }
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        assumeTrue(p.waitFor(30, TimeUnit.SECONDS) && p.exitValue() == 0, "python3 did not answer: " + out);
        assertEquals(List.of(out.split(" ")).stream().sorted().toList(),
                Spectrolyzr.PYTHON_KEYWORDS.stream().sorted().toList());
    }
}
