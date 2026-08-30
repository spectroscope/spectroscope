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

    /**
     * Every literal spelling of the folder name, whatever shape it is written in.
     *
     * <p>This is the whole vocabulary the rule below works from, and that is
     * deliberate. The first version of this test listed the SHAPES it expected a
     * hand-spelling to take — {@code ".spectro/"}, and a receiver-plus-{@code
     * resolve} regex — and a review wrote a shape that was on neither list
     * ({@code Path.of(System.getProperty("user.dir")).resolve(".spectro")
     * .resolve("launch.json")}, whose receiver is a call rather than an
     * identifier). All three tests stayed green. A list of anticipated shapes
     * cannot see the shape nobody anticipated, so the default is now the other
     * way round: <b>every occurrence is an offender until its own statement
     * proves it is the home-level folder.</b>
     */
    private static final java.util.regex.Pattern SPELLED =
            java.util.regex.Pattern.compile("\"\\.spectro");

    /**
     * What makes an occurrence the HOME-level folder rather than a project one.
     *
     * <p>Home-level {@code ~/.spectro} is a different decision that happens to
     * share a name — this machine's private state rather than something that
     * travels with a repository — and folding it in would have made one look
     * like the other. Every one of those sites reaches the home directory in the
     * same statement, so the statement is what is searched: measured on
     * 2026-08-31, this admits 32 sites and no others.
     */
    private static final java.util.regex.Pattern REACHES_HOME =
            java.util.regex.Pattern.compile("(?i)user\\.home|userhome|homedir");

    /**
     * Measured on 2026-08-31 with the walk below: 32 home-level sites.
     *
     * <p>A floor rather than the number itself, because sites come and go and a
     * count in a test is a number that goes stale. What it is here for is the
     * vacuum case: a stripper that ate the file, or a walk that found the wrong
     * tree, would report zero offenders out of zero occurrences and look exactly
     * like success.
     */
    private static final int HOME_LEVEL_SITES_FLOOR = 20;

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
        int homeLevel = 0;
        for (Path source : mainSources()) {
            if (source.getFileName().toString().equals("SpectroDir.java")) {
                continue;
            }
            String code = stripComments(Files.readString(source, StandardCharsets.UTF_8));
            java.util.regex.Matcher spelled = SPELLED.matcher(code);
            while (spelled.find()) {
                String statement = statementEndingAt(code, spelled.start());
                if (REACHES_HOME.matcher(statement).find()) {
                    homeLevel++;
                } else {
                    offenders.add(repoRoot().relativize(source) + " spells it in: "
                            + statement.strip().replaceAll("\\s+", " "));
                }
            }
        }
        assertEquals(List.of(), offenders,
                "the project folder is SpectroDir.NAME, everywhere. A site that really is"
                        + " the home-level folder reaches the home directory in the same"
                        + " statement; one that does not is this: " + offenders);
        assertTrue(homeLevel >= HOME_LEVEL_SITES_FLOOR,
                "only " + homeLevel + " home-level sites were seen — the walk or the"
                        + " comment stripper is looking at the wrong thing, and zero"
                        + " occurrences would pass this test for the wrong reason");
    }

    /**
     * The statement one occurrence sits in.
     *
     * <p>Everything back to the nearest {@code ;}, {@code &#123;} or {@code &#125;},
     * so a home-level site three lines above cannot vouch for a project-level one
     * below it.
     *
     * @param code  the source with its comments already stripped
     * @param index where the occurrence starts
     * @return the text of the statement up to that point
     */
    private static String statementEndingAt(String code, int index) {
        int start = -1;
        for (char boundary : new char[] {';', '{', '}'}) {
            start = Math.max(start, code.lastIndexOf(boundary, index));
        }
        return code.substring(start + 1, index);
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
