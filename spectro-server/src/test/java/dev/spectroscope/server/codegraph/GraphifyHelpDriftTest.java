package dev.spectroscope.server.codegraph;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 472: every subcommand and option the harness passes to graphify is one
 * that graphify's own help lists, under that subcommand.
 *
 * <p>The help text is a fixture captured from {@code graphify --help} of the
 * version {@link GraphifyCommand#PINNED_VERSION} names, stored as
 * {@code codegraph/graphify-help-<version>.txt}. The options checked are not a
 * hand list: they are read off every command line {@link GraphifyCommand#steps}
 * can build, so an option added there is checked here without anyone listing
 * it. Upgrading graphify means capturing a new fixture and moving the pin.</p>
 */
class GraphifyHelpDriftTest {

    /** A subcommand line: two spaces, then the name, then its arguments. */
    private static final Pattern SUBCOMMAND = Pattern.compile("^  ([a-z][a-z-]*)\\b.*$");
    /** An option token anywhere in a line, without its value. */
    private static final Pattern OPTION = Pattern.compile("(--[a-z][a-z-]*)");

    private static String fixture() throws IOException {
        String name = "codegraph/graphify-help-" + GraphifyCommand.PINNED_VERSION + ".txt";
        try (InputStream in = GraphifyHelpDriftTest.class.getClassLoader().getResourceAsStream(name)) {
            assertNotNull(in, "no help fixture for the pinned graphify version: " + name);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** Subcommand name to the options its section of the help lists. */
    private static Map<String, Set<String>> sections(String help) {
        Map<String, Set<String>> sections = new HashMap<>();
        String current = null;
        for (String line : help.split("\n")) {
            Matcher sub = SUBCOMMAND.matcher(line);
            if (sub.matches()) {
                current = sub.group(1);
                sections.putIfAbsent(current, new LinkedHashSet<>());
            }
            if (current == null) {
                continue;
            }
            Matcher option = OPTION.matcher(line);
            while (option.find()) {
                sections.get(current).add(option.group(1));
            }
        }
        return sections;
    }

    /** Every command line the sheet can cause, across both modes and both namings. */
    private static List<List<String>> everyCommandLine() {
        List<List<String>> lines = new ArrayList<>();
        Path folder = Path.of("/work/project");
        for (GraphifyCommand.Mode mode : GraphifyCommand.Mode.values()) {
            lines.addAll(GraphifyCommand.steps("graphify", folder, mode, null));
            lines.addAll(GraphifyCommand.steps("graphify", folder, mode,
                    new GraphifyCommand.Naming("ollama", "some-model")));
        }
        return lines;
    }

    @Test
    void theFixtureIsTheHelpOfThePinnedVersion() throws IOException {
        String help = fixture();
        assertTrue(help.startsWith("Usage: graphify <command>"), "not a graphify help text");
        assertFalse(help.contains("/Users/"), "the fixture carries a private path");
    }

    @Test
    void everySubcommandAndOptionTheHarnessPassesIsListedUnderThatSubcommand() throws IOException {
        Map<String, Set<String>> sections = sections(fixture());
        List<List<String>> lines = everyCommandLine();
        assertFalse(lines.isEmpty());
        for (List<String> argv : lines) {
            String subcommand = argv.get(1);
            Set<String> listed = sections.get(subcommand);
            assertNotNull(listed, "graphify " + GraphifyCommand.PINNED_VERSION
                    + " has no subcommand " + subcommand + " (from " + argv + ")");
            for (String token : argv.subList(2, argv.size())) {
                if (!token.startsWith("--")) {
                    continue;
                }
                String option = token.contains("=") ? token.substring(0, token.indexOf('=')) : token;
                assertTrue(listed.contains(option), "graphify " + GraphifyCommand.PINNED_VERSION + " "
                        + subcommand + " lists no " + option + "; it lists " + listed);
            }
        }
    }

    @Test
    void theBackendNamesTheHarnessMapsToAreGraphifysOwn() throws IOException {
        String help = fixture();
        // The extract section names the backends graphify ships with; the
        // naming steps take the same names (graphify's llm.BACKENDS table).
        Matcher listed = Pattern.compile("--backend B\\s+([a-z|]+)").matcher(help);
        assertTrue(listed.find(), "the help no longer lists its backends");
        Set<String> graphify = Set.of(listed.group(1).split("\\|"));
        for (String backend : GraphifyCommand.BACKENDS) {
            assertTrue(graphify.contains(backend),
                    "the harness offers a backend graphify does not list: " + backend + " not in " + graphify);
        }
    }
}
