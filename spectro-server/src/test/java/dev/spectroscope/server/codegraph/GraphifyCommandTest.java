package dev.spectroscope.server.codegraph;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Card 472: the command lines the harness hands to graphify, one per option of
 * the build sheet. Each line is an argument list, never a shell string, so the
 * assertions compare lists element by element.
 */
class GraphifyCommandTest {

    private static final String BIN = "/opt/tools/graphify";
    private static final Path FOLDER = Path.of("/work/project");

    @Test
    void aFullBuildWithoutLabelsExtractsTheCodeAndClustersWithPlaceholderNames() {
        assertEquals(List.of(
                        List.of(BIN, "extract", "/work/project", "--code-only"),
                        List.of(BIN, "cluster-only", "/work/project", "--no-label")),
                GraphifyCommand.steps(BIN, FOLDER, GraphifyCommand.Mode.FULL, null));
    }

    @Test
    void aFullBuildWithABackendKeepsExistingNamesAndNamesOnlyTheMissingOnes() {
        // Owner decision 2026-10-09: a full build must not overwrite community
        // names someone gave by hand. cluster-only without a backend keeps the
        // saved names (graphify 0.9.67 reuses .graphify_labels.json when it
        // exists), and label --missing-only names only the communities that
        // have none or a "Community N" placeholder.
        GraphifyCommand.Naming naming = new GraphifyCommand.Naming("ollama", "qwen3:8b");

        assertEquals(List.of(
                        List.of(BIN, "extract", "/work/project", "--code-only"),
                        List.of(BIN, "cluster-only", "/work/project", "--no-label"),
                        List.of(BIN, "label", "/work/project", "--missing-only",
                                "--backend=ollama", "--model=qwen3:8b")),
                GraphifyCommand.steps(BIN, FOLDER, GraphifyCommand.Mode.FULL, naming));
    }

    @Test
    void noStepOfAnyBuildRenamesACommunityThatHasAName() {
        GraphifyCommand.Naming naming = new GraphifyCommand.Naming("ollama", "qwen3:8b");
        for (GraphifyCommand.Mode mode : GraphifyCommand.Mode.values()) {
            for (List<String> step : GraphifyCommand.steps(BIN, FOLDER, mode, naming)) {
                if (step.get(1).equals("label")) {
                    assertEquals("--missing-only", step.get(3), mode + ": " + step);
                }
                if (step.get(1).equals("cluster-only")) {
                    assertEquals(List.of(BIN, "cluster-only", "/work/project", "--no-label"), step,
                            mode + ": a backend on cluster-only would name a graph that has no names yet "
                                    + "and be ignored on one that has");
                }
            }
        }
    }

    @Test
    void anUpdateWithoutLabelsIsTheOneUpdateCall() {
        assertEquals(List.of(List.of(BIN, "update", "/work/project")),
                GraphifyCommand.steps(BIN, FOLDER, GraphifyCommand.Mode.UPDATE, null));
    }

    @Test
    void anUpdateWithABackendNamesOnlyTheCommunitiesThatHaveNoNameYet() {
        GraphifyCommand.Naming naming = new GraphifyCommand.Naming("claude", "claude-haiku-4-5");

        assertEquals(List.of(
                        List.of(BIN, "update", "/work/project"),
                        List.of(BIN, "label", "/work/project", "--missing-only",
                                "--backend=claude", "--model=claude-haiku-4-5")),
                GraphifyCommand.steps(BIN, FOLDER, GraphifyCommand.Mode.UPDATE, naming));
    }

    @Test
    void theModeReadsOnlyItsTwoWireNames() {
        assertEquals(GraphifyCommand.Mode.FULL, GraphifyCommand.Mode.parse("full"));
        assertEquals(GraphifyCommand.Mode.UPDATE, GraphifyCommand.Mode.parse("update"));
        assertThrows(IllegalArgumentException.class, () -> GraphifyCommand.Mode.parse("FULL; rm -rf /"));
        assertThrows(IllegalArgumentException.class, () -> GraphifyCommand.Mode.parse(null));
    }

    @Test
    void aModelThatCouldReadAsAnOptionOrCarriesShellCharactersIsRefused() {
        for (String bad : List.of("--force", "-x", "a b", "m;rm", "m$(id)", "m`id`", "m|x", "m\nx", "", " ")) {
            assertThrows(IllegalArgumentException.class,
                    () -> new GraphifyCommand.Naming("ollama", bad), "accepted: [" + bad + "]");
        }
    }

    @Test
    void aBackendOutsideGraphifysOwnNamesIsRefused() {
        assertThrows(IllegalArgumentException.class, () -> new GraphifyCommand.Naming("--backend=x", "m"));
        assertThrows(IllegalArgumentException.class, () -> new GraphifyCommand.Naming("bedrock", "m"));
        assertThrows(IllegalArgumentException.class, () -> new GraphifyCommand.Naming(null, "m"));
    }

    @Test
    void theModelNamesThatRealBackendsUseAreAccepted() {
        for (String good : List.of("qwen3:8b", "claude-haiku-4-5", "gpt-4.1-mini",
                "openai/gpt-4o", "glm-5.3:cloud", "deepseek-v4-flash-0731@iq1_m")) {
            assertEquals(good, new GraphifyCommand.Naming("openai", good).model());
        }
    }
}
