package dev.spectroscope.core.config;

import dev.spectroscope.core.launch.LaunchFile;
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
 * Card 350, criterion 6: the project-level {@code .spectro} folder is spelled
 * once.
 *
 * <p>Two pins, because either one alone is satisfiable without the other. The
 * value pins say the constants that already existed now DERIVE from
 * {@link SpectroDir} — rename the folder and they move, or these go red. The
 * textual pin says no new site can quietly re-spell it, which is the failure
 * mode the criterion names: not that today's four are wrong, but that the fifth
 * arrives typed by hand.
 *
 * <p><b>Home-level {@code ~/.spectro} is deliberately out of scope.</b> It
 * shares a name and is a different decision — this machine's private state
 * rather than something that travels with a repository — and folding 32 sites
 * into a constant about project folders would have made one look like the
 * other. The rule below therefore matches only project-relative shapes.
 */
class SpectroDirDriftTest {

    /** The shapes that spell a PROJECT-relative .spectro path by hand. */
    private static final List<String> HAND_SPELLINGS = List.of(
            "\".spectro/",
            "\"user.dir\"), \".spectro\"");

    /**
     * {@code <something>.resolve(".spectro")}, with the receiver captured.
     *
     * <p>The receiver is what tells the two folders apart: {@code userHome()}
     * resolving {@code .spectro} is the home-level folder this rule does not
     * govern, and matching it cost a first version of this test three false
     * offenders in {@code DoctorCommand}. A home-ish receiver is skipped by
     * {@link #HOME_RECEIVER} below.
     */
    private static final java.util.regex.Pattern RESOLVED =
            java.util.regex.Pattern.compile("(\\w+(?:\\(\\))?)\\.resolve\\(\"\\.spectro\"");

    /** A receiver that is the operator's home rather than a project. */
    private static final java.util.regex.Pattern HOME_RECEIVER =
            java.util.regex.Pattern.compile("(?i).*home.*");

    /** Every project-level constant is the folder plus a name. */
    @Test
    void theProjectLevelConstantsAreDerivedFromTheOneName() {
        assertEquals(SpectroDir.NAME + "/settings.json", SpectroConfig.PROJECT_SETTINGS);
        assertEquals(SpectroDir.NAME + "/settings.local.json", SpectroConfig.WS_LOCAL_SETTINGS);
        assertEquals(SpectroDir.NAME + "/launch.json", LaunchFile.OURS);
        assertEquals(SpectroConfig.PROJECT_SETTINGS, SpectroDir.project("settings.json"));
    }

    /** The folder under one project root, as every caller of it gets it. */
    @Test
    void theFolderResolvesUnderAProjectRoot() {
        Path root = Path.of("/somewhere/project");
        assertEquals(root.resolve(".spectro"), SpectroDir.in(root));
    }

    /**
     * No main source outside {@link SpectroDir} spells a project-relative
     * {@code .spectro} path.
     *
     * <p>Comments are stripped first, so a sentence quoting the path cannot fail
     * the build and — more to the point — cannot satisfy a future reader that
     * the rule is being kept when it is not.
     */
    @Test
    void nobodyElseSpellsTheProjectFolderByHand() throws IOException {
        List<String> offenders = new ArrayList<>();
        for (Path source : mainSources()) {
            if (source.getFileName().toString().equals("SpectroDir.java")) {
                continue;
            }
            String code = stripComments(Files.readString(source, StandardCharsets.UTF_8));
            for (String shape : HAND_SPELLINGS) {
                if (code.contains(shape)) {
                    offenders.add(repoRoot().relativize(source) + " spells " + shape);
                }
            }
            java.util.regex.Matcher resolved = RESOLVED.matcher(code);
            while (resolved.find()) {
                if (!HOME_RECEIVER.matcher(resolved.group(1)).matches()) {
                    offenders.add(repoRoot().relativize(source) + " spells "
                            + resolved.group(0));
                }
            }
        }
        assertEquals(List.of(), offenders,
                "the project folder is SpectroDir.NAME, everywhere: " + offenders);
    }

    /** Every main-source java file in the repository. */
    static List<Path> mainSources() throws IOException {
        List<Path> found = new ArrayList<>();
        // Only the module trees: a walk of the repository root also descends
        // spectro-web/node_modules, which carries no java and tens of thousands
        // of files.
        try (Stream<Path> modules = Files.list(repoRoot())) {
            for (Path module : modules.filter(Files::isDirectory)
                    .filter(dir -> dir.getFileName().toString().startsWith("spectro-"))
                    .toList()) {
                Path main = module.resolve("src/main/java");
                if (!Files.isDirectory(main)) {
                    continue;
                }
                try (Stream<Path> walk = Files.walk(main)) {
                    walk.filter(path -> path.toString().endsWith(".java")).forEach(found::add);
                }
            }
        }
        assertTrue(found.size() > 100, "the walk found only " + found.size()
                + " main sources — it is looking in the wrong place");
        return found;
    }

    /** Removes block and line comments so prose cannot stand in for code. */
    static String stripComments(String source) {
        return source.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
    }

    /** Walk up to the directory that carries the Gradle settings.
     *  @return the repository root */
    static Path repoRoot() {
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
