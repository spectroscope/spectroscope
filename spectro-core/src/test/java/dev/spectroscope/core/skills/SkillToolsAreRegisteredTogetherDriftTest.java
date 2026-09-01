package dev.spectroscope.core.skills;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 358: the two halves of a skill — its body and the files beside it — are
 * registered at the same places or the second one is missing from a face nobody
 * looks at.
 *
 * <p>The list is DERIVED and not typed: the scan finds every main source that
 * calls {@code useSkillTool()} and demands the same file call
 * {@code readSkillFileTool()} exactly as often. A sixth registration site added
 * without its sibling reader turns this red on the day it lands, which a
 * hand-written list of five paths could not do.
 */
class SkillToolsAreRegisteredTogetherDriftTest {

    @Test
    void everyFaceThatRegistersUseSkillRegistersTheSiblingReaderBesideIt() throws IOException {
        List<String> mismatched = new ArrayList<>();
        List<String> sites = new ArrayList<>();
        int calls = 0;
        List<Path> sources = mainSources();
        for (Path source : sources) {
            if (source.getFileName().toString().equals("SkillLibrary.java")) {
                continue; // the factory itself — it DEFINES both, it registers neither
            }
            String code = stripComments(Files.readString(source, StandardCharsets.UTF_8));
            int uses = count(code, "useSkillTool()");
            int reads = count(code, "readSkillFileTool()");
            if (uses == 0) {
                continue;
            }
            sites.add(relative(source) + " (" + uses + ")");
            calls += uses;
            if (uses != reads) {
                mismatched.add(relative(source) + ": useSkillTool()x" + uses
                        + " but readSkillFileTool()x" + reads);
            }
        }
        // The floor counts CALLS, not files: card 358 measured five useSkillTool()
        // sites and they live in three files (SessionConnection and ContextDescriber
        // call it twice each). A file count of five would have been a number nothing
        // in the tree ever had — it failed here before the floor was corrected.
        assertTrue(calls >= 5, "the scan found only " + calls
                + " useSkillTool() calls over " + sources.size()
                + " main sources — it is looking in the wrong tree: " + sites);
        assertEquals(List.of(), mismatched,
                "a face that hands the model a skill body and not its files sends it "
                        + "hunting the filesystem, which is the defect card 358 exists for: "
                        + mismatched);
    }

    /** Occurrences of a literal — {@code String.split} would drop trailing empties. */
    private static int count(String text, String literal) {
        int found = 0;
        for (int at = text.indexOf(literal); at >= 0; at = text.indexOf(literal, at + 1)) {
            found++;
        }
        return found;
    }

    /** Every main-source java file in the repository's modules. */
    private static List<Path> mainSources() throws IOException {
        List<Path> found = new ArrayList<>();
        try (Stream<Path> modules = Files.list(repoRoot())) {
            for (Path module : modules.filter(Files::isDirectory)
                    .filter(dir -> dir.getFileName().toString().startsWith("spectro-"))
                    .sorted().toList()) {
                Path main = module.resolve("src/main/java");
                if (!Files.isDirectory(main)) {
                    continue;
                }
                try (Stream<Path> walk = Files.walk(main)) {
                    walk.filter(path -> path.toString().endsWith(".java")).sorted()
                            .forEach(found::add);
                }
            }
        }
        assertTrue(found.size() > 100, "the walk found only " + found.size()
                + " main sources — it is looking in the wrong place");
        return found;
    }

    /** The path as this test reports it. */
    private static String relative(Path source) {
        return repoRoot().relativize(source).toString().replace(java.io.File.separatorChar, '/');
    }

    /** Removes block and line comments so a javadoc mention cannot stand in for code. */
    private static String stripComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
    }

    /** Walk up to the directory that carries the Gradle settings.
     *  @return the repository root */
    private static Path repoRoot() {
        Path dir = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        while (dir != null && !Files.isRegularFile(dir.resolve("settings.gradle.kts"))) {
            dir = dir.getParent();
        }
        if (dir == null) {
            throw new IllegalStateException("no settings.gradle.kts above "
                    + System.getProperty("user.dir"));
        }
        return dir;
    }
}
