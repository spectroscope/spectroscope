package dev.spectroscope.core.config;

import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.subagents.SubagentConfig;
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
 *   <li>the <b>paths</b> are every occurrence of either builder that carries an
 *       operator's numbers into an agent — {@code AgentOptions.builder()} and
 *       {@code SubagentConfig.builder()} — in every module's
 *       {@code src/main/java}. A sixth face added tomorrow is in the set the
 *       moment it is written, whether or not anybody remembered this file.
 *       <b>The child config was added by this card's review</b>, and it was not
 *       a formality: deleting {@code .maxTurns(...)} from either shipped
 *       {@code SubagentConfig} chain left the whole 3,224-test suite green, so
 *       criterion 1's fourth face — a child agent — was in exactly the state
 *       {@code SessionConnection.maxTurns} was in before the card, present and
 *       pinned by nothing. {@code SubagentReachTest} beside this file proves
 *       {@code SubagentManager} honours the seam; only this reader proves an
 *       operator's number arrives AT it;</li>
 *   <li>the <b>keys</b> are every {@link SpectroConfig} record component that an
 *       {@link AgentOptions} component of the same name and the same (boxed)
 *       type can carry. That rule — same name, same type — is what "a settings
 *       key that maps to an AgentOptions field" means, and it excludes the two
 *       name collisions that are not mappings: config's {@code provider} is a
 *       backend id and the option is an {@code LlmProvider}, config's
 *       {@code hooks} is a list of declarations and the option is a built
 *       {@code HookRunner}. A chain is then asked only for the keys the record
 *       it builds can actually CARRY, by the same rule applied to that record —
 *       a config that has no field for a key cannot be blamed for not passing
 *       it.</li>
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
     *  declared refusal as no refusal at all.
     *
     *  <p>A window this wide used to be safe by accident, and the javadoc here
     *  said so: "the nearest two build sites in this tree are in different
     *  files". Adding the child-config chain made that false in the same commit
     *  that wrote it — {@code SessionConnection} opens a
     *  {@code SubagentConfig} chain and an {@code AgentOptions} chain within
     *  this many lines of each other, so the second one's window reached back
     *  into the first one's chain. A marker in the tail of the earlier chain
     *  would have been read as the later call's too. The window is therefore
     *  CLIPPED at the end of the preceding chain in the same file, which makes
     *  the ambiguity impossible rather than unlikely, and
     *  {@code noMarkerWindowReachesIntoAnotherBuildersChain} keeps it that
     *  way.</p> */
    private static final int MARKER_LOOKBEHIND = 14;

    /** A builder that carries an operator's numbers into an agent.
     *
     *  @param opener the literal that opens the chain in source
     *  @param target the record it builds, which decides which governed keys
     *                this chain can be asked for */
    private record Chain(String opener, Class<?> target) {
    }

    /** Both of them. {@code AgentOptions} is the agent itself; {@code
     *  SubagentConfig} is the only way an operator's number reaches a CHILD
     *  agent, and a child is a face of the app exactly like the five above it. */
    private static final List<Chain> CHAINS = List.of(
            new Chain("AgentOptions.builder()", AgentOptions.class),
            new Chain("SubagentConfig.builder()", SubagentConfig.class));

    /** One builder occurrence and the chain it opens.
     *
     *  @param file       the source file, relative to the repository root
     *  @param line       the 1-based line the chain opens on
     *  @param chain      which builder it is
     *  @param text       the chain itself, comment-stripped, for the key search
     *  @param preamble   the marker window: the lines above plus the raw chain
     *  @param windowFrom the 1-based first line of that window
     *  @param chainEnd   the 1-based line carrying this chain's {@code .build()} */
    private record BuildSite(Path file, int line, Chain chain, String text, String preamble,
                             int windowFrom, int chainEnd) {

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
        for (Chain chain : CHAINS) {
            assertTrue(sites.stream().anyMatch(site -> site.chain().equals(chain)),
                    "not one " + chain.opener() + " left in any main source. Either that"
                            + " builder was renamed — in which case this reader now walks past"
                            + " the whole family and reports green over it, which is how the"
                            + " child-agent face went unmeasured in the first place — or the"
                            + " face is gone and this entry belongs deleted with it");
            assertFalse(keysCarriedBy(chain.target(), keys).isEmpty(),
                    chain.opener() + " builds a record that can carry NONE of " + keys
                            + " any more. A chain asked for nothing is a chain that cannot"
                            + " fail, so either a component was renamed out from under this"
                            + " rule or the seam really is gone");
        }

        List<String> failures = new ArrayList<>();
        for (BuildSite site : sites) {
            Set<String> missing = new LinkedHashSet<>();
            for (String key : keysCarriedBy(site.chain().target(), keys)) {
                if (!site.text().contains("." + key + "(")) {
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
                                + " row; a key that most faces honour and one does not owes"
                                + " the reader the same sentence.\nRow: " + row);
            }
        }
    }

    @Test
    void noMarkerWindowReachesIntoAnotherBuildersChain() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");

        // The window a marker is read from is fourteen lines plus the chain
        // itself, and since the child config joined the walk two chains sit
        // closer together than that in SessionConnection. Unclipped, the second
        // one's window swallowed the tail of the first, so one marker would
        // have counted for two call sites — a refusal declared once and honoured
        // nowhere, reported green. The clipping in sitesIn is what prevents it;
        // this is what keeps the clipping honest.
        // Measured as LINE RANGES, not as a text search for the neighbouring
        // opener: the first attempt at this test looked for that literal in the
        // window and stayed green when the clipping was removed, because a
        // chain's tail carries its arguments and not the word that opened it.
        // The overlap is a fact about line numbers, so it is checked as one.
        List<BuildSite> sites = buildSites(root);
        for (int i = 1; i < sites.size(); i++) {
            BuildSite earlier = sites.get(i - 1);
            BuildSite later = sites.get(i);
            if (!earlier.file().equals(later.file())) {
                continue;
            }
            assertTrue(later.windowFrom() > earlier.chainEnd(),
                    later.where() + " reads its marker from line " + later.windowFrom()
                            + " onward, and the chain at " + earlier.where() + " runs to line"
                            + " " + earlier.chainEnd() + ". A window that reaches into a"
                            + " neighbouring chain reads that chain's marker as its own, so"
                            + " one declared refusal would silently cover two call sites and"
                            + " the second would never be asked for the keys it drops");
        }
    }

    /** The count words the guide writes, indexed by the number they spell. Ten
     *  is plenty: at eleven refusing faces the sentence in the guide is the
     *  smaller problem. */
    private static final List<String> COUNT_WORDS = List.of(
            "zero", "one", "two", "three", "four", "five",
            "six", "seven", "eight", "nine", "ten");

    @Test
    void everyPublishedRowSaysHowManyPlacesRefuseItsKey() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        Path reference = root.resolve(REFERENCE);
        assumeTrue(Files.isRegularFile(reference), "the config reference part is not here");
        String published = Files.readString(reference);

        // The review of this card added this test, and it took a bite to earn
        // it: a THIRD refusing site declaring the already-published name
        // "embedded library" left the guard above green, because that one builds
        // Map<key, Set<name>> and a set dedupes. The rows would have gone on
        // saying "Two places" over three of them. A number derivable from the
        // code does not belong in prose (CLAUDE.md); where it stands in prose
        // anyway, because a reader needs the sentence, a test counts it.
        Map<String, List<String>> refusingSites = new LinkedHashMap<>();
        for (BuildSite site : buildSites(root)) {
            Matcher marker = REFUSAL.matcher(comments(site.preamble()));
            if (!marker.find()) {
                continue;
            }
            for (String part : marker.group(1).split(",")) {
                if (!part.isBlank()) {
                    refusingSites.computeIfAbsent(part.trim(), k -> new ArrayList<>())
                            .add(site.where());
                }
            }
        }
        assertFalse(refusingSites.isEmpty(),
                "no agent-building path declares a scope refusal any more — the same news"
                        + " the test above reports, and the same answer: delete this with the"
                        + " last marker rather than leaving it green over nothing");

        for (Map.Entry<String, List<String>> entry : refusingSites.entrySet()) {
            int count = entry.getValue().size();
            assertTrue(count < COUNT_WORDS.size(),
                    entry.getKey() + " is refused by " + count + " places, past the words this"
                            + " guard can spell — widen COUNT_WORDS, or ask why so many faces"
                            + " of one app cannot honour one key");
            String row = rowFor(published, entry.getKey());
            assertFalse(row == null,
                    entry.getKey() + " is refused by " + entry.getValue() + " and has no row"
                            + " in " + REFERENCE + " at all");
            String plural = count == 1 ? "place builds" : "places build";
            Matcher says = Pattern.compile(
                    "(?i)\\b(?:" + COUNT_WORDS.get(count) + "|" + count + ")\\s+"
                            + plural.replace(" ", "\\s+") + "\\s+an\\s+agent").matcher(row);
            assertTrue(says.find(),
                    "the published row for " + entry.getKey() + " does not say \""
                            + COUNT_WORDS.get(count) + " " + plural + " an agent\", and that"
                            + " is now how many places refuse it: " + entry.getValue()
                            + ".\nRow: " + row);
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

    /** Which of the governed keys one builder's target record can carry, by the
     *  same rule that produced the keys: a component of the same name whose
     *  boxed type matches {@link AgentOptions}'.
     *
     *  <p>{@code AgentOptions} itself carries all of them by construction. A
     *  child config carries the ones it was given fields for — and the ones it
     *  has no field for are not its failure, they are a different card.</p>
     *
     *  @param target  the record the chain builds
     *  @param governed the governed keys, in the config record's order
     *  @return the subset this record can carry */
    private static List<String> keysCarriedBy(Class<?> target, List<String> governed) {
        Map<String, Class<?>> options = new LinkedHashMap<>();
        for (var component : AgentOptions.class.getRecordComponents()) {
            options.put(component.getName(), boxed(component.getType()));
        }
        Map<String, Class<?>> carried = new LinkedHashMap<>();
        for (var component : target.getRecordComponents()) {
            carried.put(component.getName(), boxed(component.getType()));
        }
        List<String> keys = new ArrayList<>();
        for (String key : governed) {
            Class<?> here = carried.get(key);
            if (here != null && here.equals(options.get(key))) {
                keys.add(key);
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

    /** Every occurrence of either {@link #CHAINS} builder in every module's
     *  main sources.
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
        int previousChainEnd = -1;
        for (int i = 0; i < lines.size(); i++) {
            Chain opened = null;
            for (Chain chain : CHAINS) {
                if (stripComment(lines.get(i)).contains(chain.opener())) {
                    opened = chain;
                    break;
                }
            }
            if (opened == null) {
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
                    root.relativize(file) + ":" + (i + 1) + " opens a " + opened.opener()
                            + " chain whose .build() this reader cannot find within 120"
                            + " lines. The chain is what the guard reads; an unreadable one"
                            + " is a green result over an unmeasured face");
            StringBuilder text = new StringBuilder();
            for (int j = i; j <= end; j++) {
                text.append(stripComment(lines.get(j))).append('\n');
            }
            StringBuilder preamble = new StringBuilder();
            // Clipped at the end of the preceding chain in this file, never
            // just at MARKER_LOOKBEHIND: SessionConnection's two chains are
            // closer together than the window is wide, so an unclipped window
            // would read the tail of the child config as the agent call's own
            // preamble and attribute a marker to both.
            int from = Math.max(Math.max(0, i - MARKER_LOOKBEHIND), previousChainEnd + 1);
            for (int j = from; j < i; j++) {
                preamble.append(lines.get(j)).append('\n');
            }
            // The marker may also sit INSIDE the chain, where the other
            // explanatory comments of these sites live — so the raw chain rides
            // along with the preamble for the marker search only, while the
            // builder-call search reads the comment-stripped copy above.
            for (int j = i; j <= end; j++) {
                preamble.append(lines.get(j)).append('\n');
            }
            sites.add(new BuildSite(root.relativize(file), i + 1, opened,
                    text.toString(), preamble.toString(), from + 1, end + 1));
            previousChainEnd = end;
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
