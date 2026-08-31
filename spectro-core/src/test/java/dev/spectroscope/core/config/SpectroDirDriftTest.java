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
     * A string literal that BEGINS with the folder name, in whatever expression
     * it is written.
     *
     * <p>This is the whole vocabulary the rule below works from, and that is
     * deliberate. The first version of this test listed the SHAPES it expected a
     * hand-spelling to take — {@code ".spectro/"}, and a receiver-plus-{@code
     * resolve} regex — and a review wrote a shape that was on neither list
     * ({@code Path.of(System.getProperty("user.dir")).resolve(".spectro")
     * .resolve("launch.json")}, whose receiver is a call rather than an
     * identifier). All three tests stayed green. A list of anticipated shapes
     * cannot see the shape nobody anticipated, so the default is now the other
     * way round: <b>every occurrence this pattern sees is an offender until its
     * own expression proves it is the home-level folder.</b>
     *
     * <p><b>What it sees is narrower than "every occurrence", so the heading says
     * which.</b> The opening quote is load-bearing: a literal that carries the
     * folder name further in — {@code "~/.spectro/settings.json"} and the other
     * twenty-nine message strings that tell an operator where a file lives — is
     * invisible here. Dropping the quote was measured on 2026-08-31 and turned
     * thirty prose sentences into offenders, not one of which builds a path.
     * Telling a path from a sentence that quotes one takes more than a regex, so
     * this stays where a hand-spelled CONSTANT is written, and the limit is
     * stated instead of hidden.
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
     * same EXPRESSION — as a sibling argument, or as the receiver the call hangs
     * off — so that expression is what is searched, and not the whole statement
     * around it. Measured on 2026-08-31 with {@link #expressionEndingAt}: 32
     * sites admitted, no offenders.
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
                String expression = expressionEndingAt(code, spelled.start());
                if (REACHES_HOME.matcher(expression).find()) {
                    homeLevel++;
                } else {
                    offenders.add(repoRoot().relativize(source) + " spells it in: "
                            + expression.strip().replaceAll("\\s+", " "));
                }
            }
        }
        assertEquals(List.of(), offenders,
                "the project folder is SpectroDir.NAME, everywhere. A site that really is"
                        + " the home-level folder reaches the home directory in the same"
                        + " expression — a sibling argument, or the receiver; one that does"
                        + " not is this: " + offenders);
        assertTrue(homeLevel >= HOME_LEVEL_SITES_FLOOR,
                "only " + homeLevel + " home-level sites were seen — the walk or the"
                        + " comment stripper is looking at the wrong thing, and zero"
                        + " occurrences would pass this test for the wrong reason");
    }

    /**
     * The expression one occurrence sits in — the call that receives it, plus
     * whatever that call hangs off.
     *
     * <p><b>It used to be the whole statement, and the sentence over it reached
     * further than it did.</b> The old walk went back to the nearest {@code ;},
     * {@code &#123;} or {@code &#125;} and claimed a home-level site three lines
     * above could not vouch for a project-level one below it. Inside one
     * multi-line expression it could, and did: both sites card 350 rewrote live
     * in one — a {@code List.of(…)} and a {@code this(…)} whose FIRST argument
     * reaches {@code user.home} and whose second was the hand-spelled project
     * path. Reverting either left this test <b>green</b>, so the guard was not
     * guarding the work it was cut for. Widened and measured on 2026-08-31: each
     * of the four rewritten sites now fails it on its own.
     *
     * <p>The scope is the innermost {@code (} still open at the occurrence,
     * extended backwards over the receiver chain in front of it. That is enough
     * for {@code Path.of(System.getProperty("user.home"), ".spectro", …)} to
     * vouch for itself through a sibling argument and for {@code
     * userHome().resolve(".spectro")} to do it through its receiver, while
     * {@code cwd.resolve(".spectro")} and {@code
     * Path.of(System.getProperty("user.dir"), ".spectro", …)} cannot. On this
     * tree it admits the same 32 home-level sites and reports no offenders.
     *
     * @param code  the source with its comments already stripped
     * @param index where the occurrence starts
     * @return the text of that expression up to the occurrence
     */
    private static String expressionEndingAt(String code, int index) {
        int statement = -1;
        for (char boundary : new char[] {';', '{', '}'}) {
            statement = Math.max(statement, code.lastIndexOf(boundary, index));
        }
        int open = openParenBefore(code, index, statement);
        if (open < 0) {
            return code.substring(statement + 1, index);
        }
        return code.substring(receiverChainBefore(code, open, statement), index);
    }

    /**
     * The innermost {@code (} still open at one point.
     *
     * @param code      the source
     * @param index     where the occurrence starts
     * @param statement where the enclosing statement begins, as a floor
     * @return its offset, or -1 when the occurrence is not inside a call
     */
    private static int openParenBefore(String code, int index, int statement) {
        int depth = 0;
        for (int at = index - 1; at > statement; at--) {
            char c = code.charAt(at);
            if (c == ')') {
                depth++;
            } else if (c == '(') {
                if (depth == 0) {
                    return at;
                }
                depth--;
            }
        }
        return -1;
    }

    /**
     * Where the receiver chain in front of one {@code (} begins.
     *
     * <p>Backwards over {@code name}, {@code .} and a balanced {@code (…)} of a
     * call's own arguments, for as long as they alternate — so {@code
     * userHome().resolve(} yields all of it and not only {@code resolve}.
     *
     * @param code      the source
     * @param open      the offset of the opening parenthesis
     * @param statement where the enclosing statement begins, as a floor
     * @return the offset the chain starts at
     */
    private static int receiverChainBefore(String code, int open, int statement) {
        int at = open;
        while (true) {
            at = skipSpaceBack(code, at, statement);
            if (at > statement + 1 && code.charAt(at - 1) == ')') {
                int depth = 0;
                while (at > statement + 1) {
                    at--;
                    if (code.charAt(at) == ')') {
                        depth++;
                    } else if (code.charAt(at) == '(' && --depth == 0) {
                        break;
                    }
                }
                at = skipSpaceBack(code, at, statement);
            }
            if (at > statement + 1 && isIdentifierChar(code.charAt(at - 1))) {
                while (at > statement + 1 && isIdentifierChar(code.charAt(at - 1))) {
                    at--;
                }
            } else {
                break;
            }
            at = skipSpaceBack(code, at, statement);
            if (at > statement + 1 && code.charAt(at - 1) == '.') {
                at--;
            } else {
                break;
            }
        }
        return at;
    }

    /** Backwards over whitespace, never past the statement.
     *  @param code the source
     *  @param at where to start
     *  @param statement the floor
     *  @return the first non-space offset */
    private static int skipSpaceBack(String code, int at, int statement) {
        while (at > statement + 1 && Character.isWhitespace(code.charAt(at - 1))) {
            at--;
        }
        return at;
    }

    /** Whether one character can appear in a java identifier.
     *  @param c the character
     *  @return true when it can */
    private static boolean isIdentifierChar(char c) {
        return Character.isLetterOrDigit(c) || c == '_' || c == '$';
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
