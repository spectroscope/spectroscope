package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 547: every subcommand and option {@code code_graph} can pass is one that
 * graphify's own help lists under that subcommand. The help is a fixture of
 * {@code graphify --help} for {@link CodeGraphTool#PINNED_VERSION}; the command
 * lines are read off {@link CodeGraphTool#argv} for every action with every
 * optional flag set, so a flag added there is checked here without a hand list.
 */
class CodeGraphHelpDriftTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern SUBCOMMAND = Pattern.compile("^  ([a-z][a-z-]*)\\b.*$");
    private static final Pattern OPTION = Pattern.compile("(--[a-z][a-z-]*)");

    private static String fixture() throws IOException {
        String name = "codegraph/graphify-help-" + CodeGraphTool.PINNED_VERSION + ".txt";
        try (InputStream in = CodeGraphHelpDriftTest.class.getClassLoader().getResourceAsStream(name)) {
            assertNotNull(in, "no help fixture for the pinned graphify version: " + name);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

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

    /** One input per action with every optional flag set. */
    private static List<ObjectNode> fullInputs() {
        return List.of(
                JSON.createObjectNode().put("action", "query").put("question", "q").put("dfs", true)
                        .put("budget", 2000),
                JSON.createObjectNode().put("action", "path").put("from", "A").put("to", "B"),
                JSON.createObjectNode().put("action", "explain").put("name", "X"),
                JSON.createObjectNode().put("action", "affected").put("name", "X").put("depth", 2),
                JSON.createObjectNode().put("action", "god_nodes").put("top", 10));
    }

    private static List<List<String>> everyCommandLine() {
        List<List<String>> lines = new ArrayList<>();
        Path graph = Path.of("/work/project/graphify-out/graph.json");
        for (ObjectNode input : fullInputs()) {
            CodeGraphTool.Request request = CodeGraphTool.parse(input).request();
            assertNotNull(request, "the full input parses: " + input);
            lines.add(CodeGraphTool.argv("graphify", request, graph));
        }
        return lines;
    }

    @Test
    void theFixtureIsTheHelpOfThePinnedVersion() throws IOException {
        String help = fixture();
        assertTrue(help.startsWith("Usage: graphify <command>"), "not a graphify help text");
        assertFalse(help.contains("/Users/"), "the fixture carries a private path");
        assertEquals("0.9.67", CodeGraphTool.PINNED_VERSION);
    }

    @Test
    void theFiveActionsMapToTheFiveSubcommands() {
        List<String> subcommands = everyCommandLine().stream().map(argv -> argv.get(1)).toList();
        assertEquals(List.of("query", "path", "explain", "affected", "god-nodes"), subcommands);
        assertEquals(List.of("query", "path", "explain", "affected", "god_nodes"), CodeGraphTool.ACTIONS);
    }

    @Test
    void everySubcommandAndOptionTheToolPassesIsListedUnderThatSubcommand() throws IOException {
        Map<String, Set<String>> sections = sections(fixture());
        for (List<String> argv : everyCommandLine()) {
            String subcommand = argv.get(1);
            Set<String> listed = sections.get(subcommand);
            assertNotNull(listed, "graphify " + CodeGraphTool.PINNED_VERSION + " has no subcommand "
                    + subcommand + " (from " + argv + ")");
            for (String token : argv.subList(2, argv.size())) {
                if (token.startsWith("--")) {
                    assertTrue(listed.contains(token), "graphify " + CodeGraphTool.PINNED_VERSION + " "
                            + subcommand + " lists no " + token + "; it lists " + listed);
                }
            }
            assertTrue(argv.contains("--graph"), "every call names its graph: " + argv);
        }
    }
}
