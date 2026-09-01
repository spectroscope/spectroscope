package dev.spectroscope.core.config;

import dev.spectroscope.core.AgentOptions;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 364: a settings key that reached one face out of five.
 *
 * <p>Measured on the branch this card was cut from:
 * {@code AgentOptions.Builder.maxTurns(...)} had exactly ONE call site in every
 * main source of every module — {@code SessionConnection}, the browser session
 * — while the key had a settings control, a documentation row, a
 * {@code ReachBlock} and a drift test. {@code spectro run}, the cron daemon, a
 * fleet node and every child agent fell through to {@code Agent.DEFAULT_MAX_TURNS}
 * and could not be moved by anything an operator typed. The sibling
 * {@code maxTokens} builder method had ZERO call sites: public, documented and
 * dead.</p>
 *
 * <p><b>Why this guard is a call-site count and not a list of paths.</b> A hand
 * list of the faces, checked by a test that types the same hand list, is two
 * copies of one claim — this house has paid for that shape three times in one
 * card. So both halves are derived:</p>
 *
 * <ul>
 *   <li>the <b>paths</b> are every {@code AgentOptions.builder()} occurrence in
 *       every module's {@code src/main/java}. A sixth face added tomorrow is in
 *       the set the moment it is written, whether or not anybody remembered
 *       this file;</li>
 *   <li>the <b>keys</b> are every {@link SpectroConfig} record component that an
 *       {@link AgentOptions} component of the same name and the same (boxed)
 *       type can carry. That rule — same name, same type — is what "a settings
 *       key that maps to an AgentOptions field" means, and it excludes the two
 *       name collisions that are not mappings: config's {@code provider} is a
 *       backend id and the option is an {@code LlmProvider}, config's
 *       {@code hooks} is a list of declarations and the option is a built
 *       {@code HookRunner}.</li>
 * </ul>
 *
 * <p><b>What this test does NOT claim.</b> It reads for the builder CALL, not
 * for the value passed to it: {@code .maxTurns(3)} would satisfy it. The
 * arrival of the operator's own number is measured by running an agent, in
 * {@code HeadlessRunnerReachTest} and {@code SubagentReachTest} beside this
 * file and in {@code SessionMaxTurnsTest} in the server module. The sentence
 * here is deliberately the narrower one, because a syntactic reader cannot
 * honestly make the wider one.</p>
 *
 * <p>A path that legitimately cannot honour a key says so AT THE CALL SITE, in
 * a machine-read marker, and the name it declares has to appear in the
 * published row for that key — so criterion 4's "a key that cannot reach a path
 * says so" is enforced from the source rather than remembered.</p>
 */
class AgentBuildReachDriftTest {

    /** The published key table — the reader's copy of what a key governs. */
    private static final Path REFERENCE =
            Path.of("docs/guide-assets/parts/18-ref-config-build.html");

    /** The refusal marker, read off a run of comment lines JOINED into one —
     *  the same marker wraps over four or five lines at both shipped sites, and
     *  a reader that only looked at single lines would have forced a 550-column
     *  comment to keep itself machine-readable.
     *
     *  <p>Pipes rather than dashes: a reason is allowed to contain every kind of
     *  dash this house writes, and a separator that can appear inside the field
     *  it separates is not a separator.</p> */
    private static final Pattern REFUSAL = Pattern.compile(
            "settings-reach:\\s*([^|]+?)\\s*\\|\\s*([^|]+?)\\s*\\|\\s*(.+)");

    /** How far above a builder call a marker may sit and still be read as its
     *  own. Fourteen lines: the longer of the two shipped markers wraps over
     *  nine, and the window has to hold the WHOLE marker because the key list
     *  is on its first line — a window that clipped the front would read a
     *  declared refusal as no refusal at all. Short enough that a marker cannot
     *  drift onto the wrong call: the nearest two build sites in this tree are
     *  in different files. */
    private static final int MARKER_LOOKBEHIND = 14;

    /** One {@code AgentOptions.builder()} occurrence and the chain it opens. */
    private record BuildSite(Path file, int line, String chain, String preamble) {

        /** @return {@code module/path/File.java:line}, the way a grep prints it */
        String where() {
            return file + ":" + line;
        }
    }

    @Test
    void everyPathThatBuildsAnAgentPassesEverySettingThatMapsOntoOne() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        List<String> keys = governedKeys();
        assertFalse(keys.isEmpty(),
                "no settings key maps onto an AgentOptions field any more — either the"
                        + " record was rewritten or the mapping rule (same name, same boxed"
                        + " type) stopped describing it, and this guard is now watching"
                        + " nothing while reporting green");

        List<BuildSite> sites = buildSites(root);
        assertTrue(sites.size() >= 2,
                "found " + sites.size() + " place(s) that build an agent, which cannot be"
                        + " right — the walk over */src/main/java is broken, and a broken"
                        + " walk is this guard's own way of going green over the defect");

        List<String> failures = new ArrayList<>();
        for (BuildSite site : sites) {
            Set<String> missing = new LinkedHashSet<>();
            for (String key : keys) {
                if (!site.chain().contains("." + key + "(")) {
                    missing.add(key);
                }
            }
            Matcher marker = REFUSAL.matcher(comments(site.preamble()));
            Set<String> refused = new LinkedHashSet<>();
            String name = null;
            String reason = null;
            if (marker.find()) {
                for (String part : marker.group(1).split(",")) {
                    if (!part.isBlank()) {
                        refused.add(part.trim());
                    }
                }
                name = marker.group(2).trim();
                reason = marker.group(3).trim();
            }
            if (missing.isEmpty() && refused.isEmpty()) {
                continue;
            }
            if (!missing.equals(refused)) {
                failures.add(site.where() + " builds an agent without "
                        + (missing.isEmpty() ? "nothing" : missing)
                        + " and declares a refusal for "
                        + (refused.isEmpty() ? "nothing" : refused));
                continue;
            }
            if (name == null || name.isBlank()) {
                failures.add(site.where() + " refuses " + missing + " under no name");
            } else if (reason == null || reason.length() < 20) {
                failures.add(site.where() + " refuses " + missing + " with no reason worth"
                        + " reading: \"" + reason + "\"");
            }
        }
        assertTrue(failures.isEmpty(),
                "a path that builds an agent drops a setting an operator can type, and says"
                        + " nothing about it. That is the whole of card 364: the number on"
                        + " the settings page was true of the browser session and of nothing"
                        + " else. Either pass it at the call site, or declare the refusal"
                        + " there —\n    // settings-reach: <keys> | <name> | <why not>\n"
                        + "— and name the same <name> in the key's row of " + REFERENCE
                        + ".\nOffending sites:\n  " + String.join("\n  ", failures));
    }

    @Test
    void everyRefusalIsNamedInThePublishedRowOfTheKeyItRefuses() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        Path reference = root.resolve(REFERENCE);
        assumeTrue(Files.isRegularFile(reference), "the config reference part is not here");
        String published = Files.readString(reference);

        // Card 364 criterion 4. The refusals are DISCOVERED, not listed: a
        // seventh face that declares one is checked against the guide the day it
        // is written, and a refusal quietly deleted from the source stops being
        // demanded of the guide in the same commit.
        Map<String, Set<String>> refusalsByKey = new LinkedHashMap<>();
        for (BuildSite site : buildSites(root)) {
            Matcher marker = REFUSAL.matcher(comments(site.preamble()));
            if (!marker.find()) {
                continue;
            }
            String name = marker.group(2).trim();
            for (String part : marker.group(1).split(",")) {
                if (!part.isBlank()) {
                    refusalsByKey.computeIfAbsent(part.trim(), k -> new TreeSet<>()).add(name);
                }
            }
        }
        assertFalse(refusalsByKey.isEmpty(),
                "no agent-building path declares a scope refusal any more. If every face"
                        + " now honours every key that is excellent news — delete this test"
                        + " with the last marker rather than leaving it green over nothing");

        for (Map.Entry<String, Set<String>> entry : refusalsByKey.entrySet()) {
            String row = rowFor(published, entry.getKey());
            assertFalse(row == null,
                    entry.getKey() + " is refused by " + entry.getValue() + " and has no row"
                            + " in " + REFERENCE + " at all — an operator meets the refusal"
                            + " with nowhere to look it up");
            for (String name : entry.getValue()) {
                assertTrue(row.contains(name),
                        "the published row for " + entry.getKey() + " never says \"" + name
                                + "\", which is a path that does not honour it. The"
                                + " process-global keys name their scope refusal in their own"
                                + " row; a key that reaches four faces out of six owes the"
                                + " reader the same sentence.\nRow: " + row);
            }
        }
    }

    /** Every settings key an {@link AgentOptions} field of the same name and the
     *  same boxed type can carry.
     *
     *  @return the mapped key names, in the config record's own order */
    private static List<String> governedKeys() {
        Map<String, Class<?>> options = new LinkedHashMap<>();
        for (var component : AgentOptions.class.getRecordComponents()) {
            options.put(component.getName(), boxed(component.getType()));
        }
        List<String> keys = new ArrayList<>();
        for (var component : SpectroConfig.class.getRecordComponents()) {
            Class<?> option = options.get(component.getName());
            if (option != null && option.equals(boxed(component.getType()))) {
                keys.add(component.getName());
            }
        }
        return keys;
    }

    /** {@code int} and {@code Integer} are the same setting seen from two sides;
     *  {@code String} and {@code LlmProvider} are not.
     *
     *  @param type a record component's declared type
     *  @return its wrapper when primitive, itself otherwise */
    private static Class<?> boxed(Class<?> type) {
        if (!type.isPrimitive()) {
            return type;
        }
        return switch (type.getName()) {
            case "boolean" -> Boolean.class;
            case "int" -> Integer.class;
            case "long" -> Long.class;
            case "double" -> Double.class;
            case "float" -> Float.class;
            case "short" -> Short.class;
            case "byte" -> Byte.class;
            case "char" -> Character.class;
            default -> type;
        };
    }

    /** Every {@code AgentOptions.builder()} in every module's main sources.
     *
     *  @param root the repository root
     *  @return one entry per occurrence, with its chain text
     *  @throws IOException when the tree cannot be walked */
    private static List<BuildSite> buildSites(Path root) throws IOException {
        List<BuildSite> sites = new ArrayList<>();
        try (Stream<Path> modules = Files.list(root)) {
            List<Path> mains = modules
                    .map(module -> module.resolve("src/main/java"))
                    .filter(Files::isDirectory)
                    .sorted()
                    .toList();
            for (Path main : mains) {
                try (Stream<Path> files = Files.walk(main)) {
                    for (Path file : files.filter(p -> p.toString().endsWith(".java"))
                            .sorted().toList()) {
                        sites.addAll(sitesIn(root, file));
                    }
                }
            }
        }
        return sites;
    }

    /** Splits one file into its builder chains.
     *
     *  <p>The chain runs from the line that opens it to the first line carrying
     *  {@code .build()}, which is how all of them are written and, more to the
     *  point, is checked: a chain whose end cannot be found fails the walk
     *  loudly instead of being scanned as an empty string that satisfies
     *  nothing and nobody notices.</p>
     *
     *  @param root the repository root, for a readable relative path
     *  @param file the source file
     *  @return its build sites
     *  @throws IOException when the file cannot be read */
    private static List<BuildSite> sitesIn(Path root, Path file) throws IOException {
        List<String> lines = Files.readAllLines(file);
        List<BuildSite> sites = new ArrayList<>();
        for (int i = 0; i < lines.size(); i++) {
            if (!stripComment(lines.get(i)).contains("AgentOptions.builder()")) {
                continue;
            }
            int end = -1;
            for (int j = i; j < lines.size() && j < i + 120; j++) {
                if (stripComment(lines.get(j)).contains(".build()")) {
                    end = j;
                    break;
                }
            }
            assertTrue(end >= 0,
                    root.relativize(file) + ":" + (i + 1) + " opens an AgentOptions chain"
                            + " whose .build() this reader cannot find within 120 lines."
                            + " The chain is what the guard reads; an unreadable one is a"
                            + " green result over an unmeasured face");
            StringBuilder chain = new StringBuilder();
            for (int j = i; j <= end; j++) {
                chain.append(stripComment(lines.get(j))).append('\n');
            }
            StringBuilder preamble = new StringBuilder();
            for (int j = Math.max(0, i - MARKER_LOOKBEHIND); j < i; j++) {
                preamble.append(lines.get(j)).append('\n');
            }
            // The marker may also sit INSIDE the chain, where the other
            // explanatory comments of these six sites live — so the raw chain
            // rides along with the preamble for the marker search only, while
            // the builder-call search reads the comment-stripped copy above.
            for (int j = i; j <= end; j++) {
                preamble.append(lines.get(j)).append('\n');
            }
            sites.add(new BuildSite(root.relativize(file), i + 1,
                    chain.toString(), preamble.toString()));
        }
        return sites;
    }

    /** Every run of consecutive comment lines in a region, each run folded into
     *  ONE logical line so a marker may wrap the way its neighbours do.
     *
     *  @param region the source lines to read
     *  @return one line per comment run, comment slashes removed */
    private static String comments(String region) {
        StringBuilder all = new StringBuilder();
        boolean inRun = false;
        for (String line : region.split("\n", -1)) {
            String trimmed = line.strip();
            if (trimmed.startsWith("//")) {
                if (!inRun) {
                    all.append('\n');
                    inRun = true;
                }
                all.append(' ').append(trimmed.substring(2).strip());
            } else {
                inRun = false;
            }
        }
        return all.toString();
    }

    /** Drops a line comment so a builder call NAMED in prose is not counted as
     *  one MADE in code — the exact substring-not-parse trap this house keeps
     *  finding.
     *
     *  @param line one source line
     *  @return the code half of it */
    private static String stripComment(String line) {
        int at = line.indexOf("//");
        return at < 0 ? line : line.substring(0, at);
    }

    /** The published table row for one key.
     *
     *  <p>Scoped to the {@code ch-config-keys} table and anchored on the row's
     *  FIRST cell, and both halves were paid for: the loose version of this
     *  reader matched {@code <tr><td><code>SPECTRO_THINKING</code></td><td><code>thinking</code></td></tr>}
     *  in the deprecated-environment table further up, so the guard reported
     *  that {@code thinking} had no scope sentence while looking at a row that
     *  could never carry one. A substring of a document is not a row of a
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
        String keyTable = published.substring(table, published.indexOf("</table>", table));
        Matcher row = Pattern.compile(
                "<tr><td><code>" + Pattern.quote(key) + "</code></td>.*?</tr>",
                Pattern.DOTALL).matcher(keyTable);
        return row.find() ? row.group() : null;
    }

    /** Walks up to the directory holding the Gradle settings file. */
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
