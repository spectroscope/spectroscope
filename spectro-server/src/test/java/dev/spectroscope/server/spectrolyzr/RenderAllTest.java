package dev.spectroscope.server.spectrolyzr;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link RenderAll} is what the CI job renders every archetype with: six
 * project folders and three playbook folders per language, deterministic, and
 * it refuses to write over an earlier run.
 */
class RenderAllTest {

    private record Outcome(int exit, String out, String err) {}

    private static Outcome run(String... args) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteArrayOutputStream err = new ByteArrayOutputStream();
        int exit = RenderAll.run(args, new PrintStream(out, true, StandardCharsets.UTF_8),
                new PrintStream(err, true, StandardCharsets.UTF_8));
        return new Outcome(exit, out.toString(StandardCharsets.UTF_8), err.toString(StandardCharsets.UTF_8));
    }

    private static List<String> children(Path dir) throws IOException {
        try (Stream<Path> s = Files.list(dir)) {
            return s.map(p -> p.getFileName().toString()).sorted().toList();
        }
    }

    private static Map<String, String> bytesOf(Path root) throws IOException {
        Map<String, String> out = new TreeMap<>();
        try (Stream<Path> s = Files.walk(root)) {
            for (Path p : s.filter(Files::isRegularFile).toList()) {
                out.put(root.relativize(p).toString(),
                        Base64.getEncoder().encodeToString(Files.readAllBytes(p)));
            }
        }
        return out;
    }

    @Test
    void rendersSixProjectFoldersAndThreePlaybookFoldersForALanguage(@TempDir Path tmp) throws IOException {
        Path out = tmp.resolve("lyzr");
        Outcome o = run("--out", out.toString(), "--language", "python");
        assertEquals(0, o.exit(), o.err());

        assertEquals(List.of("cli-bare", "cli-full", "library-bare", "library-full", "service-bare", "service-full"),
                children(out));
        List<String> projects = new ArrayList<>();
        List<String> playbooks = new ArrayList<>();
        for (String variant : children(out)) {
            if (Files.isDirectory(out.resolve(variant).resolve("project"))) {
                projects.add(variant);
            }
            if (Files.isDirectory(out.resolve(variant).resolve("playbook"))) {
                playbooks.add(variant);
            }
        }
        assertEquals(6, projects.size());
        assertEquals(List.of("cli-full", "library-full", "service-full"), playbooks);

        assertTrue(Files.isRegularFile(out.resolve("service-bare/project/pyproject.toml")));
        assertTrue(Files.isRegularFile(out.resolve("service-full/project/scripts/gate.py")));
        assertTrue(Files.isRegularFile(out.resolve("service-full/playbook/playbook.json")));
        assertTrue(Files.readString(out.resolve("service-bare/project/pyproject.toml")).contains("ledger-api"),
                "the sample name is ledger-api");
    }

    @Test
    void printsOneLineForEveryFolderWithItsCheckCommandAndWritesTheSameCommandBeside() throws IOException {
        Path out = Files.createTempDirectory("lyzr-print").resolve("o");
        Outcome o = run("--out", out.toString(), "--language", "python");
        assertEquals(0, o.exit(), o.err());

        List<String> lines = o.out().lines().toList();
        assertEquals(6, lines.size(), o.out());
        assertTrue(lines.contains("service-bare\tpython3 -m unittest discover -s tests -t . -v"), o.out());
        assertTrue(lines.contains("service-full\tpython3 scripts/gate.py"), o.out());
        assertEquals("python3 scripts/gate.py", Files.readString(out.resolve("service-full/check-command.txt")).strip());
        assertEquals("python3 -m unittest discover -s tests -t . -v",
                Files.readString(out.resolve("library-bare/check-command.txt")).strip());
    }

    @Test
    void theCheckCommandsOfTheOtherTwoLanguagesAreTheirTestAndGateCommands(@TempDir Path tmp) throws IOException {
        Outcome ts = run("--out", tmp.resolve("ts").toString(), "--language", "typescript");
        assertEquals(0, ts.exit(), ts.err());
        assertTrue(ts.out().lines().toList().contains("cli-bare\tnpm test"), ts.out());
        assertTrue(ts.out().lines().toList().contains("cli-full\tnode scripts/gate.mjs"), ts.out());

        Outcome java = run("--out", tmp.resolve("java").toString(), "--language", "java");
        assertEquals(0, java.exit(), java.err());
        assertTrue(java.out().lines().toList().contains("library-bare\tgradle test"), java.out());
        assertTrue(java.out().lines().toList().contains("library-full\tgradle gate"), java.out());
    }

    @Test
    void aSecondRunIntoAFreshFolderGivesIdenticalBytes(@TempDir Path tmp) throws IOException {
        assertEquals(0, run("--out", tmp.resolve("a").toString(), "--language", "python").exit());
        assertEquals(0, run("--out", tmp.resolve("b").toString(), "--language", "python").exit());
        Map<String, String> first = bytesOf(tmp.resolve("a"));
        assertTrue(first.size() > 30, "a real tree was written: " + first.size());
        assertEquals(first, bytesOf(tmp.resolve("b")));
    }

    @Test
    void aSecondRunIntoTheSameFolderIsRefusedAndKeepsTheFirst(@TempDir Path tmp) throws IOException {
        Path out = tmp.resolve("o");
        assertEquals(0, run("--out", out.toString(), "--language", "python").exit());
        Map<String, String> before = bytesOf(out);
        Outcome again = run("--out", out.toString(), "--language", "python");
        assertNotEquals(0, again.exit());
        assertTrue(again.err().contains("service-bare"), again.err());
        assertEquals(before, bytesOf(out));
    }

    @Test
    void anUnknownLanguageAndMissingArgumentsAreRefusedWithAUsageLine(@TempDir Path tmp) {
        Outcome unknown = run("--out", tmp.resolve("x").toString(), "--language", "cobol");
        assertNotEquals(0, unknown.exit());
        assertTrue(unknown.err().contains("cobol"), unknown.err());
        assertTrue(unknown.err().contains("typescript"), "the known languages are named: " + unknown.err());

        Outcome none = run();
        assertNotEquals(0, none.exit());
        assertTrue(none.err().contains("--out"), none.err());
        assertTrue(none.err().contains("--language"), none.err());
    }
}
