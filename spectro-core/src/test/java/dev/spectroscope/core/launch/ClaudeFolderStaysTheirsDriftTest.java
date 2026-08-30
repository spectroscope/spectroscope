package dev.spectroscope.core.launch;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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

    /**
     * The only file-system calls a source that names another vendor's folder may
     * make — an ALLOWLIST, and that is the whole of the fix.
     *
     * <p>This test used to carry the opposite: eleven hand-typed spellings of
     * "this writes". A review then added a real write of
     * {@code <project>/.claude/launch.json} to {@link LaunchFile} — {@code
     * mkdirs()} through {@code java.io.File}, then {@code Files.newByteChannel}
     * — and the guard stayed <b>green</b>, because neither form was on the list.
     * A list of the ways somebody might write cannot see the way nobody thought
     * of, and {@code java.nio.file.Files} keeps growing. So the deny side is now
     * enumerated nowhere: <b>every {@code Files.} call that is not named below is
     * an offence</b>, and so is naming any of the JDK handles in
     * {@link #WRITE_HANDLE} that open a file without going through {@code Files}
     * at all.
     *
     * <p>Every name here is checked against the real API by
     * {@link #theReadOnlyAllowlistIsMadeOfMethodsThatExist()}, so it cannot drift
     * into fiction.
     */
    private static final Set<String> READ_ONLY_FILES_CALLS = Set.of(
            "exists", "notExists", "isRegularFile", "isDirectory", "isReadable",
            "isHidden", "isSameFile", "isSymbolicLink", "readString", "readAllBytes",
            "readAllLines", "readAttributes", "readSymbolicLink", "lines", "list",
            "walk", "find", "newBufferedReader", "newInputStream", "newDirectoryStream",
            "size", "getLastModifiedTime", "getAttribute", "getOwner", "getFileStore",
            "getPosixFilePermissions", "getFileAttributeView", "probeContentType",
            "mismatch");

    /**
     * The JDK's other way to open a file for writing, and the bridge to it.
     *
     * <p>{@code java.io.File} is the mutable half of the old API — {@code
     * mkdirs}, {@code delete}, {@code renameTo}, {@code createNewFile} all hang
     * off it — so a source under this rule may not name the type at all, nor
     * {@code toFile()}, which is the one door from a {@link Path} to it. The rest
     * are the stream and channel handles that take a filename directly. Unlike
     * {@code Files}, these are a closed set: {@code java.io} has not grown a new
     * file-writing handle since {@code RandomAccessFile}.
     */
    private static final Pattern WRITE_HANDLE = Pattern.compile(
            "(?<![A-Za-z0-9_$])(AsynchronousFileChannel|OutputStreamWriter"
                    + "|FileOutputStream|RandomAccessFile|BufferedWriter|FileChannel"
                    + "|PrintWriter|FileWriter|PrintStream|Formatter|toFile|File)"
                    + "(?![A-Za-z0-9_$])");

    /** Any java identifier, for the class-reference walk in the reachability test. */
    private static final Pattern IDENTIFIER = Pattern.compile("[A-Za-z_$][A-Za-z0-9_$]*");

    /** {@code Files.<something>}, as a source spells it. */
    private static final Pattern FILES_CALL = Pattern.compile("\\bFiles\\.(\\w+)");

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
        int reads = 0;
        for (Path source : mainSources()) {
            String code = stripComments(Files.readString(source, StandardCharsets.UTF_8));
            if (!code.contains(".claude")) {
                continue;
            }
            Matcher call = FILES_CALL.matcher(code);
            while (call.find()) {
                if (READ_ONLY_FILES_CALLS.contains(call.group(1))) {
                    reads++;
                } else {
                    offenders.add(relative(source) + " calls Files." + call.group(1));
                }
            }
            Matcher handle = WRITE_HANDLE.matcher(code);
            while (handle.find()) {
                offenders.add(relative(source) + " names " + handle.group(1));
            }
        }
        assertEquals(List.of(), offenders,
                "the owner's rule: we read their folder, we never write it. A source that"
                        + " names .claude may only make the reads in READ_ONLY_FILES_CALLS,"
                        + " and may not name java.io.File or a stream that writes: "
                        + offenders);
        assertTrue(reads > 0, "no file-system call at all was seen in a source that names"
                + " .claude — the walk or the comment stripper is looking at the wrong"
                + " thing, and nothing would ever fail this test");
    }

    /** The allowlist is made of methods that exist, so it cannot drift into fiction. */
    @Test
    void theReadOnlyAllowlistIsMadeOfMethodsThatExist() {
        List<String> real = new ArrayList<>();
        for (Method method : Files.class.getMethods()) {
            if (Modifier.isStatic(method.getModifiers())) {
                real.add(method.getName());
            }
        }
        List<String> invented = READ_ONLY_FILES_CALLS.stream()
                .filter(name -> !real.contains(name)).sorted().toList();
        assertEquals(List.of(), invented,
                "these are not methods of java.nio.file.Files: " + invented);
    }

    /**
     * And the rule as a fact about the file system rather than about the source.
     *
     * <p>The scan above is lexical, so it cannot see a write that goes through a
     * helper in another file. This one cannot see a write nobody calls — the
     * review's bite was an uncalled method, and this test would have passed it.
     * They are complements, not alternatives: between them, a write that is
     * reachable is caught by running it, and a write that is merely written is
     * caught by reading it.
     */
    @Test
    void theirFolderIsByteIdenticalAfterTheProductHasReadAndWritten(@TempDir Path project)
            throws Exception {
        Path theirs = project.resolve(LaunchFile.THEIRS);
        Files.createDirectories(theirs.getParent());
        Files.writeString(theirs, """
                {"version":"0.0.1","configurations":[{"name":"theirs","port":9999}]}
                """, StandardCharsets.UTF_8);
        Map<String, String> before = snapshot(theirs.getParent());

        LaunchFile.readFrom(project).orElseThrow();
        LaunchWriter.write(project, List.of(new LaunchEntry("ours", 5173, "npm",
                List.of("run", "dev"), null, List.of())));
        LaunchFile.readFrom(project).orElseThrow();

        assertEquals(before, snapshot(theirs.getParent()),
                "reading their file, writing ours, and reading again left their folder"
                        + " changed — the owner's rule is that it is theirs");
    }

    /** Every file under one folder, by relative path, with its bytes. */
    private static Map<String, String> snapshot(Path folder) throws IOException {
        Map<String, String> found = new LinkedHashMap<>();
        try (Stream<Path> walk = Files.walk(folder)) {
            for (Path path : walk.filter(Files::isRegularFile).sorted().toList()) {
                found.put(folder.relativize(path).toString(),
                        Files.readString(path, StandardCharsets.UTF_8));
            }
        }
        return found;
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

    /** One parser in the product, as the owner asked: a second Java reader is nonsense. */
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
     * And the same question asked of the whole repository, not just the JVM.
     *
     * <p>The test above walks {@code spectro-*&#47;src/main/java}, so "one
     * parser" was true of the product and not of the repository. A review found
     * the other one: {@code cockpit/serve.py} reads this format for the developer
     * dashboard, and until 2026-08-31 it looked only in {@code .claude}, so a
     * project configured the new way read as EMPTY there while the app showed its
     * configurations. It follows the same precedence now, and it is listed here
     * rather than quietly excluded — the point of a pin is that a THIRD reader is
     * a decision somebody takes on purpose.
     *
     * <p>Why the cockpit gets to be a second reader at all: it is a standalone
     * page served by a Python script with no JVM anywhere near it, so "call the
     * one parser" is not available to it. The rule it does have to keep is the
     * order, and {@code cockpit/test_serve.py} pins that.
     */
    @Test
    void everySourceInTheRepositoryThatReadsTheLaunchFormatIsOneOfThese()
            throws IOException {
        List<String> readers = new ArrayList<>();
        int scanned = 0;
        try (Stream<Path> walk = Files.walk(repoRoot())) {
            for (Path path : walk.filter(Files::isRegularFile).sorted().toList()) {
                String shown = relative(path).replace(java.io.File.separatorChar, '/');
                if (!isScannableSource(shown)) {
                    continue;
                }
                scanned++;
                String text = Files.readString(path, StandardCharsets.UTF_8);
                if (shown.endsWith(".java")) {
                    text = stripComments(text);
                }
                if (text.contains("\"configurations\"")) {
                    readers.add(shown);
                }
            }
        } catch (java.io.UncheckedIOException unreadable) {
            throw new IOException(unreadable);
        }
        assertTrue(scanned > 400, "only " + scanned + " sources were scanned — the walk is"
                + " looking at the wrong tree, and nothing would ever fail this test");
        assertEquals(List.of(
                "cockpit/serve.py",
                "spectro-core/src/main/java/dev/spectroscope/core/launch/LaunchFile.java",
                "spectro-core/src/main/java/dev/spectroscope/core/launch/LaunchWriter.java"),
                readers,
                "a fourth source reading the launch format is a decision, not a refactor."
                        + " If it is one, it also has to follow LaunchFile.LOCATIONS: "
                        + readers);
    }

    /** Whether one repository path is source this scan should read. */
    private static boolean isScannableSource(String shown) {
        for (String noise : List.of(".git/", "node_modules/", "/build/", "build/", ".gradle/",
                "dist/", "/out/", ".venv/", "worktrees/", "src/test/",
                "src/main/resources/static/")) {
            if (shown.startsWith(noise) || shown.contains("/" + noise)) {
                return false;
            }
        }
        String name = shown.substring(shown.lastIndexOf('/') + 1);
        if (name.startsWith("test_") || name.endsWith("Test.java")
                || name.contains(".test.") || name.contains(".spec.")) {
            return false;
        }
        for (String extension : List.of(".java", ".py", ".ts", ".tsx", ".js", ".mjs",
                ".html", ".sh")) {
            if (name.endsWith(extension)) {
                return true;
            }
        }
        return false;
    }

    /**
     * ⛔ No tool reaches the writer — through any number of hops.
     *
     * <p>Card 352 criterion 1 is unanswered, so the door stays shut in a way that
     * a future author trips over rather than has to know about. Wiring
     * {@link LaunchWriter} into a tool turns this red, which is the moment to go
     * and ask.
     *
     * <p><b>It has to be transitive, and it was not.</b> The first version asked
     * whether one source both built tools and named {@code LaunchWriter}. A
     * review put a one-class relay between the two and the guard stayed
     * <b>green</b> — which is not a reachability guard, it is a guard against
     * writing the two words in one file. So the check now walks: from every
     * source that builds a tool, through every class it names, to whatever those
     * name, and reports the PATH it found rather than only the endpoint.
     *
     * <p>The graph is built from simple class names, so it over-approximates: an
     * identifier that happens to match a class name makes an edge that no call
     * follows. That is the safe direction for a door that is supposed to be shut
     * — a false red sends somebody to look, a false green ships the decision the
     * owner has not made.
     */
    @Test
    void noAgentToolCanReachTheWriter() throws IOException {
        Map<String, String> code = new LinkedHashMap<>();
        for (Path source : mainSources()) {
            String name = source.getFileName().toString().replace(".java", "");
            code.merge(name, stripComments(Files.readString(source, StandardCharsets.UTF_8)),
                    (first, second) -> first + "\n" + second);
        }
        Map<String, String> reachedBy = new LinkedHashMap<>();
        List<String> frontier = new ArrayList<>();
        for (Map.Entry<String, String> source : code.entrySet()) {
            if (buildsTools(source.getValue())) {
                reachedBy.put(source.getKey(), source.getKey());
                frontier.add(source.getKey());
            }
        }
        assertTrue(frontier.size() >= 5, "only " + frontier.size() + " tool-building sources"
                + " were found — the walk is looking at the wrong tree, and an empty"
                + " frontier reaches nothing and passes for the wrong reason");
        while (!frontier.isEmpty()) {
            List<String> next = new ArrayList<>();
            for (String from : frontier) {
                Matcher word = IDENTIFIER.matcher(code.get(from));
                while (word.find()) {
                    String to = word.group();
                    if (code.containsKey(to) && !reachedBy.containsKey(to)) {
                        reachedBy.put(to, reachedBy.get(from) + " → " + to);
                        next.add(to);
                    }
                }
            }
            frontier = next;
        }
        assertFalse(reachedBy.containsKey("LaunchWriter"),
                "an agent that can author a launch entry can arrange for arbitrary code to"
                        + " run on the next play; the owner has not said yes. The path is: "
                        + reachedBy.get("LaunchWriter") + " (" + reachedBy.size()
                        + " classes are reachable from a tool at all)");
    }

    /** Whether one source is somewhere a tool is defined. */
    private static boolean buildsTools(String code) {
        return code.contains("Tool.ToolContext") || code.contains("implements Tool")
                || code.contains("extends Tool");
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
