package dev.spectroscope.core.launch;

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
 * Card 350, criterion 3, and card 352, criterion 1 — as guards over the tree
 * rather than as rules everybody has to remember.
 *
 * <p>Three of them, and they answer three different questions:
 *
 * <ol>
 *   <li><b>Nothing writes into {@code .claude}.</b> Not "nothing does today" —
 *       no source that can write a file may even name the folder. The owner's
 *       rule is that another vendor's folder is theirs, and a convention that
 *       lives only in a card survives exactly as long as everyone remembers
 *       reading it.</li>
 *   <li><b>The parser exists once.</b> The owner said a second reader of the
 *       same shape would be nonsense, and card 350 made that harder to keep by
 *       adding a location. So the reading is pinned to one file.</li>
 *   <li><b>No tool reaches {@link LaunchWriter}.</b> Whether an AGENT may
 *       author a launch file is an open owner call, and an open question is a
 *       shut door until it is answered.</li>
 * </ol>
 *
 * <p>Comments are stripped everywhere first, so this class's own prose about
 * {@code .claude} — and every javadoc paragraph that has to name the folder to
 * explain the rule — cannot fail the build, and cannot satisfy it either.
 *
 * <p><b>One trap, measured on 2026-08-31:</b> this test lives in
 * {@code spectro-core} and reads {@code spectro-server}'s sources, so Gradle's
 * up-to-date check does not re-run it when only those move. A bite of
 * {@code SkillsController} came back green for exactly that reason before it
 * was re-run with {@code --rerun-tasks}. The full gate runs with that flag; a
 * quick single-module run does not.
 */
class ClaudeFolderStaysTheirsDriftTest {

    /** Every way a java source reaches the file system to change something. */
    private static final List<String> WRITES = List.of(
            "Files.write", "Files.newBufferedWriter", "Files.newOutputStream",
            "Files.createFile", "Files.createDirector", "Files.copy", "Files.move",
            "Files.delete", "new FileWriter", "new PrintWriter", "new FileOutputStream");

    /** The main sources that are allowed to name the folder at all, and why. */
    private static final List<String> MAY_NAME_IT = List.of(
            // the read half of card 350 — the location constant itself
            "spectro-core/src/main/java/dev/spectroscope/core/launch/LaunchFile.java",
            // ~/.claude/projects: Claude Code's transcripts, which ARE their data
            "spectro-server/src/main/java/dev/spectroscope/server/transcripts/"
                    + "ClaudeTranscriptsController.java");

    /** Nothing that can write a file may so much as name another vendor's folder. */
    @Test
    void nothingThatWritesEvenNamesTheClaudeFolder() throws IOException {
        List<String> offenders = new ArrayList<>();
        for (Path source : mainSources()) {
            String code = stripComments(Files.readString(source, StandardCharsets.UTF_8));
            if (!code.contains(".claude")) {
                continue;
            }
            List<String> writes = WRITES.stream().filter(code::contains).toList();
            if (!writes.isEmpty()) {
                offenders.add(relative(source) + " names .claude and calls " + writes);
            }
        }
        assertEquals(List.of(), offenders,
                "the owner's rule: we read their folder, we never write it — " + offenders);
    }

    /** And the ones that name it are the two that were decided, not a growing set. */
    @Test
    void onlyTheTwoDecidedSourcesNameTheClaudeFolder() throws IOException {
        List<String> naming = new ArrayList<>();
        for (Path source : mainSources()) {
            if (stripComments(Files.readString(source, StandardCharsets.UTF_8))
                    .contains(".claude")) {
                naming.add(relative(source));
            }
        }
        assertEquals(MAY_NAME_IT, naming,
                "a third source reaching into Claude Code's folder is a decision, not a"
                        + " refactor — take it deliberately and add it here: " + naming);
    }

    /** One parser, as the owner asked: a second reader of the same shape is nonsense. */
    @Test
    void exactlyOneSourceReadsTheLaunchFormat() throws IOException {
        List<String> parsers = new ArrayList<>();
        for (Path source : mainSources()) {
            if (stripComments(Files.readString(source, StandardCharsets.UTF_8))
                    .contains("\"configurations\"")) {
                parsers.add(relative(source));
            }
        }
        assertEquals(
                List.of("spectro-core/src/main/java/dev/spectroscope/core/launch/LaunchFile.java",
                        "spectro-core/src/main/java/dev/spectroscope/core/launch/"
                                + "LaunchWriter.java"),
                parsers,
                "the format is read in one place and written in one place; a third"
                        + " source touching \"configurations\" is a second dialect: " + parsers);
    }

    /**
     * ⛔ No tool reaches the writer.
     *
     * <p>Card 352 criterion 1 is unanswered, so the door stays shut in a way that
     * a future author trips over rather than has to know about. Wiring
     * {@link LaunchWriter} into a tool turns this red, which is the moment to go
     * and ask.
     */
    @Test
    void noAgentToolCanReachTheWriter() throws IOException {
        List<String> offenders = new ArrayList<>();
        for (Path source : mainSources()) {
            String code = stripComments(Files.readString(source, StandardCharsets.UTF_8));
            boolean buildsTools = code.contains("Tool.ToolContext")
                    || code.contains("implements Tool")
                    || code.contains("extends Tool");
            if (buildsTools && code.contains("LaunchWriter")) {
                offenders.add(relative(source));
            }
        }
        assertEquals(List.of(), offenders,
                "an agent that can author a launch entry can arrange for arbitrary code to"
                        + " run on the next play; the owner has not said yes: " + offenders);
    }

    /** And no launch verb beyond the five card 202 shipped is rated in the map. */
    @Test
    void theTierMapCarriesNoWritingLaunchVerb() throws IOException {
        String tiers = Files.readString(repoRoot().resolve("spectro-core/src/main/resources/"
                + "permission/tool-tiers.json"), StandardCharsets.UTF_8);
        List<String> verbs = new ArrayList<>();
        java.util.regex.Matcher found =
                java.util.regex.Pattern.compile("\"(launch_\\w+)\"").matcher(tiers);
        while (found.find()) {
            verbs.add(found.group(1));
        }
        assertEquals(List.of("launch_list", "launch_logs", "launch_stop", "launch_start",
                "launch_restart"), verbs,
                "a sixth launch verb is card 352's owner call arriving through the map: "
                        + verbs);
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
        return repoRoot().relativize(source).toString();
    }

    /** Removes block and line comments so prose cannot stand in for code. */
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
