package dev.spectroscope.server;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The repository root carries three executables, each named after its job:
 * {@code spectro-app} is the developer's way into the product,
 * {@code spectro-serve} owns the server lifecycle, and {@code spectro-env}
 * brings the docker stacks in {@code ci/} up and down. The shipped CLI is a
 * fourth thing and keeps the bare name {@code spectro}; it arrives in a release
 * zip as {@code bin/spectro} and is not in this tree.
 *
 * <p>Renaming one of those three is a two-second {@code git mv} and the
 * references are the whole job — the move that produced this test touched
 * roughly thirty files across scripts, docs, the built user guide and a sibling
 * drift test. A page that still tells a reader to run {@code ./ci/spectro-ci}
 * after the file moved is not a stale sentence, it is an instruction that
 * fails.</p>
 *
 * <p>So the root is read off disk and every tracked text file is walked: a path
 * that names a root script and does not resolve fails here rather than in
 * somebody's terminal. Rename one again and the leftovers are listed for you.</p>
 */
class RootScriptNameDriftTest {

    static final Path ROOT = LangfuseComposeDriftTest.repoRoot();

    /** The shape a root script's name has: {@code spectro} or {@code spectro-<word>}. */
    private static final Pattern ROOT_SCRIPT_NAME = Pattern.compile("spectro(-[a-z]+)?");

    /** A repository-relative invocation: {@code ./spectro-env}, {@code ./ci/spectro-ci}. */
    private static final Pattern DOT_SLASH_PATH = Pattern.compile("\\./([A-Za-z0-9_.@/-]+)");

    /** The same path written without the {@code ./}: {@code ci/spectro-ci}. */
    private static final Pattern BARE_PATH = Pattern.compile(
            "(?<![\\w./-])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*/spectro(?:-[a-z]+)?)(?![\\w./-])");

    /** Extensions whose bytes are not prose and would only be read to be discarded. */
    private static final Set<String> BINARY = Set.of(
            "png", "jpg", "jpeg", "webp", "gif", "ico", "icns", "pdf", "zip", "jar",
            "ttf", "woff", "woff2", "otf", "mp3", "mp4", "wav", "bin", "node", "dmg",
            "deb", "exe", "class", "keystore");

    /**
     * Names in the root-script shape that are not root scripts.
     * {@code spectro-board} is the board server in the private product home this
     * checkout sits inside, and the cockpit page links to it on purpose;
     * {@code spectro-pty} is the native terminal helper, compiled into
     * {@code native/} and the desktop kit and never present in a fresh clone.
     */
    private static final Set<String> NOT_A_ROOT_SCRIPT = Set.of("spectro-board", "spectro-pty");

    // ── the root itself ────────────────────────────────────────────────────────

    /**
     * The set from the card's own scenario, read off disk. Hard-coded on purpose:
     * renaming one of the three has to arrive here, and this javadoc is where the
     * next renamer lands.
     */
    @Test
    void theRootCarriesThreeToolsEachNamedAfterItsJob() throws IOException {
        assertEquals(List.of("spectro-app", "spectro-env", "spectro-serve"),
                List.copyOf(rootScripts()),
                "the executables in the repository root are not the three this repo documents");
    }

    /**
     * The bare name belongs to the shipped CLI. A file called {@code spectro} in
     * this root is the ambiguity card 213 removed: two things, one name, and a
     * reader who cannot tell which one a page means.
     */
    @Test
    void theBareNameIsLeftToTheShippedCli() {
        assertFalse(Files.exists(ROOT.resolve("spectro")),
                "the root wrapper is spectro-app; `spectro` is the name the release zip ships");
    }

    // ── every reference to one of them ─────────────────────────────────────────

    /**
     * The guard the rename exists for. Every path in every tracked text file that
     * ends in a root-script name must resolve.
     *
     * <p>The bare {@code ./spectro} is skipped here and only here: in prose it is
     * the shipped CLI ({@code ./spectro run …} out of the release zip), which is
     * not a file in this tree. {@link #everyScriptCallsAFileThatExists()} takes
     * the bare name back for anything executable, where the path has to resolve
     * or the line does not run.</p>
     */
    @Test
    void everyPathNamingARootScriptResolves() throws Exception {
        List<String> dangling = new ArrayList<>();
        for (Path file : trackedTextFiles()) {
            for (String path : scriptPaths(read(file), false)) {
                if (!resolves(file, path)) {
                    dangling.add(ROOT.relativize(file) + " → " + path);
                }
            }
        }
        assertTrue(dangling.isEmpty(),
                "these paths name a root script that is not there:\n  " + String.join("\n  ", dangling));
    }

    /**
     * The same walk over the things that actually run, with the bare name
     * included: a shell script or a workflow step that says {@code ./spectro}
     * is not describing a release zip, it is calling a file.
     */
    @Test
    void everyScriptCallsAFileThatExists() throws Exception {
        List<String> dangling = new ArrayList<>();
        for (Path file : trackedTextFiles()) {
            if (!isRunnable(file)) {
                continue;
            }
            for (String path : scriptPaths(read(file), true)) {
                if (!resolves(file, path)) {
                    dangling.add(ROOT.relativize(file) + " → " + path);
                }
            }
        }
        assertTrue(dangling.isEmpty(),
                "these runnable files call something that is not there:\n  " + String.join("\n  ", dangling));
    }

    // ── and the page a reader meets ────────────────────────────────────────────

    /** A root script nobody can find is the same problem from the other side. */
    @Test
    void theReadmeNamesAllThreeOfThem() throws IOException {
        String readme = Files.readString(ROOT.resolve("README.md"));
        List<String> absent = new ArrayList<>();
        for (String script : rootScripts()) {
            if (!readme.contains("./" + script)) {
                absent.add(script);
            }
        }
        assertTrue(absent.isEmpty(), "README.md never mentions: " + absent);
    }

    /**
     * Criterion 4 of the card, pinned. The wrapper and the shipped CLI carry
     * different names on purpose, and a reader who meets {@code ./spectro-app}
     * next to a download called {@code spectro} has to be told that once,
     * plainly, rather than left to guess which of the two is a typo.
     */
    @Test
    void theReadmeSaysWhyTheWrapperIsNotCalledSpectro() throws IOException {
        String readme = Files.readString(ROOT.resolve("README.md")).toLowerCase(Locale.ROOT);
        assertTrue(readme.contains("developer wrapper"),
                "README.md must name ./spectro-app as this repository's developer wrapper");
        assertTrue(readme.contains("shipped cli"),
                "README.md must say that the shipped CLI is called spectro, so the two names read as a choice");
    }

    // ── the reading ────────────────────────────────────────────────────────────

    /** The executables sitting directly in the root, sorted. */
    static Set<String> rootScripts() throws IOException {
        try (Stream<Path> entries = Files.list(ROOT)) {
            Set<String> names = new TreeSet<>();
            entries.filter(Files::isRegularFile)
                    .filter(Files::isExecutable)
                    .map(entry -> entry.getFileName().toString())
                    .filter(name -> ROOT_SCRIPT_NAME.matcher(name).matches())
                    .forEach(names::add);
            return names;
        }
    }

    /**
     * Paths in {@code text} whose last segment is a root-script name.
     *
     * <p>Two spellings are read. {@code ./x/y} is repository-relative by
     * definition. {@code x/y} without the dot is only taken when {@code x} is
     * something this root actually has — otherwise a sentence about
     * {@code spectroscope-harness/spectro} in a neighbouring checkout would be
     * measured against this tree and fail for being somewhere else.</p>
     */
    private static List<String> scriptPaths(String text, boolean includeBareName) {
        Set<String> found = new LinkedHashSet<>();
        Matcher dotted = DOT_SLASH_PATH.matcher(text);
        while (dotted.find()) {
            collect(found, trim(dotted.group(1)), includeBareName);
        }
        Matcher bare = BARE_PATH.matcher(text);
        while (bare.find()) {
            String path = trim(bare.group(1));
            String first = path.substring(0, path.indexOf('/'));
            if (Files.exists(ROOT.resolve(first))) {
                collect(found, path, includeBareName);
            }
        }
        return List.copyOf(found);
    }

    private static void collect(Set<String> into, String path, boolean includeBareName) {
        // Both spellings arrive here; one name in the failure list is enough.
        if (path.startsWith("./")) {
            path = path.substring(2);
        }
        String base = path.substring(path.lastIndexOf('/') + 1);
        if (!ROOT_SCRIPT_NAME.matcher(base).matches() || NOT_A_ROOT_SCRIPT.contains(base)) {
            return;
        }
        // spectro-server, spectro-desktop, spectro-web and the rest are Gradle
        // modules. A path ending in one of them names that directory or something
        // built inside it, never a script in the root.
        if (Files.isDirectory(ROOT.resolve(base))) {
            return;
        }
        if (base.equals("spectro") && !includeBareName) {
            return;
        }
        into.add(path);
    }

    /**
     * A path in a file is read the way a reader would read it: against the
     * repository root, or against the directory the file itself sits in.
     */
    private static boolean resolves(Path file, String path) {
        return Files.exists(ROOT.resolve(path)) || Files.exists(file.getParent().resolve(path));
    }

    /** Prose punctuation that a path picks up on its way out of a sentence. */
    private static String trim(String path) {
        int end = path.length();
        while (end > 0 && ".,:;)]'\"`".indexOf(path.charAt(end - 1)) >= 0) {
            end--;
        }
        return path.substring(0, end);
    }

    private static boolean isRunnable(Path file) {
        String name = file.getFileName().toString();
        String rel = ROOT.relativize(file).toString();
        return name.endsWith(".sh")
                || rel.startsWith(".github/workflows/")
                || (!rel.contains("/") && Files.isExecutable(file));
    }

    private static String read(Path file) throws IOException {
        return new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
    }

    /** Every tracked file whose bytes are prose, source or configuration. */
    private static List<Path> trackedTextFiles() throws Exception {
        Process process = new ProcessBuilder("git", "ls-files", "-z")
                .directory(ROOT.toFile()).redirectErrorStream(true).start();
        String listing = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(process.waitFor(60, TimeUnit.SECONDS), "git ls-files hung");
        assertEquals(0, process.exitValue(), "git ls-files failed:\n" + listing);

        List<Path> files = new ArrayList<>();
        for (String entry : listing.split("\0")) {
            if (entry.isBlank()) {
                continue;
            }
            int dot = entry.lastIndexOf('.');
            String extension = dot < 0 ? "" : entry.substring(dot + 1).toLowerCase(Locale.ROOT);
            if (BINARY.contains(extension)) {
                continue;
            }
            Path file = ROOT.resolve(entry);
            if (Files.isRegularFile(file)) {
                files.add(file);
            }
        }
        assertTrue(files.size() > 500, "only " + files.size() + " tracked text files — the listing is wrong");
        return files;
    }
}
