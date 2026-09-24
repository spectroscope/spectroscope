package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 370, criterion 4: the tool-belt road into a run gets the derived reach
 * guard the agent-options road already has.
 *
 * <p>{@code commandTimeoutSeconds} had a settings control, a reference row, a
 * {@code ReachBlock}, a web test, an entry in the governing-numbers registry
 * and a Java test, and not one shipped run read it. Every belt in every module
 * was built by the no-argument {@code StandardTools.all()}, and the overload
 * that takes the budget was package-private while all five faces that need it
 * sit in other packages. {@code AgentBuildReachDriftTest} could not see any of
 * it: that guard derives its paths from {@code AgentOptions.builder()} and
 * {@code SubagentConfig.builder()}, and this key travels neither. A second road
 * into a run had no reader at all.</p>
 *
 * <p><b>Both halves are derived from the source.</b> The sites are every
 * occurrence of {@code StandardTools.all(} in every module's
 * {@code src/main/java}, so a sixth belt written tomorrow is in the set the day
 * it is written, whether or not anybody remembered this file. The verdict per
 * site is read off the call itself: an argument is reach, and no argument has
 * to carry a marker that says why. A hand list of faces checked by a test that
 * types the same hand list is the shape this house has paid for four times, and
 * card 370 exists because the previous card was scoped from a signature rather
 * than from the calls.</p>
 *
 * <p><b>A call NAMED in prose is not a call MADE in code.</b> Five javadoc
 * blocks in these modules write {@code StandardTools.all()} while explaining
 * what a belt is, and a substring search counts every one of them as a bare
 * call. The scan therefore strips block comments, line comments, string
 * literals and character literals before it looks, which is the
 * substring-instead-of-parse trap this house keeps finding in its own
 * readers.</p>
 *
 * <p><b>What this reader cannot see.</b> It is a line scan, so it finds the
 * call only where {@code StandardTools.all(} stands on one line as written:
 * a line break between {@code StandardTools} and {@code .all(}, a space before
 * the parenthesis, and a static import that calls a bare {@code all(} all walk
 * past it. None of the three appears in these modules today, and a belt written
 * in one of those forms tomorrow would be invisible here rather than reported.
 * The sentence above is therefore about every occurrence THIS SCAN CAN SEE, and
 * closing the gap means parsing Java rather than lines.</p>
 *
 * <p><b>The marker window is a comment RUN, not a line count.</b> A window of N
 * lines can reach past a neighbouring call and read that call's marker as its
 * own: {@code Tools.java} holds two calls a few lines apart, and one declared
 * refusal covering both would be a refusal honoured nowhere and reported green.
 * The run of comment lines directly above a call cannot span a neighbouring
 * call, because a call is not a comment.</p>
 */
class ToolBeltReachDriftTest {

    /** The published key table, the reader's copy of what this key governs. */
    private static final Path REFERENCE =
            Path.of("docs/guide-assets/parts/18-ref-config-build.html");

    /** The key this guard is about. */
    private static final String KEY = "commandTimeoutSeconds";

    /** What opens a belt. */
    private static final String CALL = "StandardTools.all(";

    /** A call that carries something. The first character after the bracket is
     *  neither whitespace nor the closing bracket, so {@code all()} fails it and
     *  {@code all(config.commandTimeoutSeconds())} passes. */
    private static final Pattern WIRED = Pattern.compile("StandardTools\\.all\\(\\s*[^\\s)]");

    /** The house's refusal grammar, the one {@code AgentBuildReachDriftTest}
     *  reads: keys, then a name, then a reason. Pipes rather than dashes,
     *  because a reason may contain every kind of dash. */
    private static final Pattern REFUSAL = Pattern.compile(
            "settings-reach:\\s*([^|]+?)\\s*\\|\\s*([^|]+?)\\s*\\|\\s*(.{20,})");

    /** The marker for a call that reads nothing but tool names or a count. */
    private static final String NAMES_ONLY = "belt-names-only";

    /** One occurrence of {@link #CALL} and what the source says about it.
     *
     *  @param file    the source file, relative to the repository root
     *  @param line    the 1-based line the call sits on
     *  @param wired   true when the call carries an argument
     *  @param comment the comment run directly above it, folded into one line */
    private record BeltSite(Path file, int line, boolean wired, String comment) {

        /** @return {@code module/path/File.java:line}, the way a grep prints it */
        String where() {
            return file + ":" + line;
        }
    }

    @Test
    void everyBeltARunUsesIsBuiltWithTheConfiguredBudgetOrSaysWhyNot() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");

        List<BeltSite> sites = beltSites(root);
        assertTrue(sites.size() >= 5,
                "found " + sites.size() + " place(s) that build a standard belt, which"
                        + " cannot be right. The walk over */src/main/java is broken, and a"
                        + " broken walk is this guard's own way of reporting green over the"
                        + " defect it exists to find");

        List<String> wired = new ArrayList<>();
        List<String> refusals = new ArrayList<>();
        List<String> namesOnly = new ArrayList<>();
        List<String> failures = new ArrayList<>();
        for (BeltSite site : sites) {
            if (site.wired()) {
                wired.add(site.where());
                continue;
            }
            Matcher marker = REFUSAL.matcher(site.comment());
            if (marker.find() && refusedKeys(marker.group(1)).contains(KEY)) {
                String name = marker.group(2).trim();
                if (name.isBlank()) {
                    failures.add(site.where() + " refuses " + KEY + " under no name");
                } else {
                    refusals.add(site.where());
                }
                continue;
            }
            if (site.comment().contains(NAMES_ONLY)) {
                namesOnly.add(site.where());
                continue;
            }
            failures.add(site.where() + " builds a belt with StandardTools.all() and says"
                    + " nothing about the budget it drops");
        }

        assertTrue(failures.isEmpty(),
                "a belt a run actually uses is built without the shell budget an operator"
                        + " can type, and nothing at the call site says why. That is the whole"
                        + " of card 370: the settings page promised that a save reaches the"
                        + " next session, and no session read the key at all. Either pass it"
                        + " at the call site,\n"
                        + "    StandardTools.all(config." + KEY + "())\n"
                        + "or declare the refusal above it in the house grammar,\n"
                        + "    // settings-reach: " + KEY + " | <name> | <why not>\n"
                        + "and name the same <name> in the key's row of " + REFERENCE + ",\n"
                        + "or, for a call that reads only tool names or a count, say so,\n"
                        + "    // " + NAMES_ONLY + ": reads Tool::name or size(),"
                        + " no budget applies (card 370)\n"
                        + "Offending sites:\n  " + String.join("\n  ", failures));

        assertTrue(wired.size() >= 4,
                "only " + wired.size() + " belt(s) carry the configured budget: " + wired
                        + ". The faces a run goes through are the browser session, the child"
                        + " belt, the headless runner, the CLI and the context describer, and"
                        + " a guard that accepts fewer is watching the state card 364 found"
                        + " maxTurns in, where one face out of five was wired and the page"
                        + " spoke for all of them");
        assertFalse(refusals.isEmpty(),
                "no belt declares a refusal any more. If every face now honours the key"
                        + " that is excellent news, and this assertion and the published"
                        + " sentence it guards are deleted together rather than left green"
                        + " over nothing");
        assertFalse(namesOnly.isEmpty(),
                "no belt is built for its tool NAMES any more. The three that were read"
                        + " Tool::name or size(), and if they are gone their marker's"
                        + " sentence in this guard goes with them");
    }

    @Test
    void theRefusalIsNamedInThePublishedRow() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        Path reference = root.resolve(REFERENCE);
        assumeTrue(Files.isRegularFile(reference), "the config reference part is not here");
        String published = Files.readString(reference);

        // Discovered, not listed: a face that declares a refusal tomorrow is
        // checked against the guide the day it is written, and a refusal quietly
        // deleted from the source stops being demanded of the guide in the same
        // commit.
        Set<String> names = new LinkedHashSet<>();
        for (BeltSite site : beltSites(root)) {
            Matcher marker = REFUSAL.matcher(site.comment());
            if (marker.find() && refusedKeys(marker.group(1)).contains(KEY)) {
                names.add(marker.group(2).trim());
            }
        }
        assertFalse(names.isEmpty(),
                "no belt declares a refusal of " + KEY + " any more, so there is nothing"
                        + " left for the published row to owe the reader");

        String row = rowFor(published, KEY);
        assertFalse(row == null,
                KEY + " is refused by " + names + " and has no row in " + REFERENCE + " at"
                        + " all, so an operator meets the refusal with nowhere to look it up");
        for (String name : names) {
            assertTrue(row.contains(name),
                    "the published row for " + KEY + " never says \"" + name + "\", and that"
                            + " is a place which builds a belt and cannot honour the key. A"
                            + " row that describes reach owes the reader the exception by"
                            + " name.\nRow: " + row);
        }
    }

    /** The keys one marker declares.
     *
     *  @param declared the comma-separated first field of the marker
     *  @return the key names, trimmed */
    private static Set<String> refusedKeys(String declared) {
        Set<String> keys = new LinkedHashSet<>();
        for (String part : declared.split(",")) {
            if (!part.isBlank()) {
                keys.add(part.trim());
            }
        }
        return keys;
    }

    /** Every occurrence of {@link #CALL} in every module's main sources.
     *
     *  @param root the repository root
     *  @return one entry per occurrence, in file and line order
     *  @throws IOException when the tree cannot be walked */
    private static List<BeltSite> beltSites(Path root) throws IOException {
        List<BeltSite> sites = new ArrayList<>();
        try (Stream<Path> modules = Files.list(root)) {
            List<Path> mains = modules
                    .map(module -> module.resolve("src/main/java"))
                    .filter(Files::isDirectory)
                    .sorted()
                    .toList();
            for (Path main : mains) {
                try (Stream<Path> files = Files.walk(main)) {
                    for (Path file : files.filter(path -> path.toString().endsWith(".java"))
                            .sorted().toList()) {
                        sites.addAll(sitesIn(root, file));
                    }
                }
            }
        }
        return sites;
    }

    /** Splits one file into its belt sites.
     *
     *  @param root the repository root, for a readable relative path
     *  @param file the source file
     *  @return its belt sites
     *  @throws IOException when the file cannot be read */
    private static List<BeltSite> sitesIn(Path root, Path file) throws IOException {
        List<String> lines = Files.readAllLines(file);
        List<String> code = codeOnly(lines);
        List<BeltSite> sites = new ArrayList<>();
        for (int i = 0; i < code.size(); i++) {
            if (!code.get(i).contains(CALL)) {
                continue;
            }
            sites.add(new BeltSite(root.relativize(file), i + 1,
                    WIRED.matcher(code.get(i)).find(), commentRunAbove(lines, i)));
        }
        return sites;
    }

    /** The run of line comments directly above a line, folded into one logical
     *  line so a marker may wrap the way its neighbours do.
     *
     *  @param lines the whole file
     *  @param at    the 0-based index of the call
     *  @return the comment run with its slashes removed, or an empty string */
    private static String commentRunAbove(List<String> lines, int at) {
        int from = at;
        while (from > 0 && lines.get(from - 1).strip().startsWith("//")) {
            from--;
        }
        StringBuilder run = new StringBuilder();
        for (int i = from; i < at; i++) {
            run.append(' ').append(lines.get(i).strip().substring(2).strip());
        }
        return run.toString();
    }

    /** The code half of every line: block comments, line comments, string
     *  literals and character literals removed.
     *
     *  <p>Written as a scanner rather than as an index search because both
     *  shortcuts produce a silent green. Stopping at the first {@code //} counts
     *  the five javadoc blocks that name this call in prose; not handling
     *  literals lets a {@code "http://"} in a string swallow the rest of its own
     *  line, and a real call after it would never be seen.</p>
     *
     *  @param lines the whole file
     *  @return one code-only string per line, same length and same order */
    private static List<String> codeOnly(List<String> lines) {
        List<String> code = new ArrayList<>();
        boolean inBlock = false;
        for (String line : lines) {
            StringBuilder kept = new StringBuilder();
            int i = 0;
            while (i < line.length()) {
                if (inBlock) {
                    if (line.startsWith("*/", i)) {
                        inBlock = false;
                        i += 2;
                    } else {
                        i++;
                    }
                    continue;
                }
                char here = line.charAt(i);
                if (line.startsWith("/*", i)) {
                    inBlock = true;
                    i += 2;
                } else if (line.startsWith("//", i)) {
                    break;
                } else if (here == '"' || here == '\'') {
                    i = endOfLiteral(line, i);
                } else {
                    kept.append(here);
                    i++;
                }
            }
            code.add(kept.toString());
        }
        return code;
    }

    /** Where a string or character literal ends.
     *
     *  @param line  the source line
     *  @param start the index of the opening quote
     *  @return the index just past the closing quote, or the line's end */
    private static int endOfLiteral(String line, int start) {
        char quote = line.charAt(start);
        int i = start + 1;
        while (i < line.length()) {
            char here = line.charAt(i);
            if (here == '\\') {
                i += 2;
            } else if (here == quote) {
                return i + 1;
            } else {
                i++;
            }
        }
        return line.length();
    }

    /** The published table row for one key.
     *
     *  <p>Scoped to the {@code ch-config-keys} table and anchored on the row's
     *  first cell, for the reason {@code AgentBuildReachDriftTest} records
     *  beside its own copy: a substring of a document is not a row of a
     *  table.</p>
     *
     *  @param published the config reference part
     *  @param key       the settings key
     *  @return the row's markup, or null when the key has no row */
    private static String rowFor(String published, String key) {
        int table = published.indexOf("id=\"ch-config-keys\"");
        if (table < 0) {
            return null;
        }
        int end = published.indexOf("</table>", table);
        // A -1 here used to reach substring as an end index, and the guard died
        // with a StringIndexOutOfBoundsException instead of saying what it could
        // not read. A reader that crashes teaches nobody where to look.
        assertTrue(end > table,
                "the ch-config-keys table in " + REFERENCE + " never closes, so no row can"
                        + " be read out of it. Either the markup is broken or this reader's"
                        + " anchor no longer describes the chapter");
        String keyTable = published.substring(table, end);
        Matcher row = Pattern.compile(
                "<tr><td><code>" + Pattern.quote(key) + "</code></td>.*?</tr>",
                Pattern.DOTALL).matcher(keyTable);
        return row.find() ? row.group() : null;
    }

    /** Walks up to the directory holding the Gradle settings file.
     *
     *  @return the repository root, or null when this is not a source checkout */
    private static Path repoRoot() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
