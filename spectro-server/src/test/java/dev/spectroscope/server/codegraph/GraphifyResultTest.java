package dev.spectroscope.server.codegraph;

import dev.spectroscope.core.tools.ToolPath;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 587, criterion 2: what a finished build means for the chat, read off
 * what graphify printed. A full build is built, an update that changed nothing
 * is already current, any other update is updated, and both carry the counts
 * graphify wrote. graphify 0.9.67 exits 0 in all three, so the output is the
 * only place "already current" shows.
 *
 * <p>The fixtures under {@code codegraph/graphify-output-0.9.67/} are what
 * {@code ~/.local/bin/graphify} printed on a two-file Python folder on
 * 2026-10-13, the folder replaced by {@code /work/project}. The last test runs
 * the real program and skips where it is not installed.</p>
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class GraphifyResultTest {

    private static List<String> fixture(String name) throws IOException {
        String path = "codegraph/graphify-output-" + GraphifyCommand.PINNED_VERSION + "/" + name + ".txt";
        try (InputStream in = GraphifyResultTest.class.getClassLoader().getResourceAsStream(path)) {
            assertNotNull(in, "no fixture " + path);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8).lines().toList();
        }
    }

    private static CodeGraphJobs.Snapshot ended(String mode, String state, List<String> tail) {
        return new CodeGraphJobs.Snapshot("/work/project", "s-587", mode, state, "2026-10-13T10:00:00Z",
                CodeGraphJobs.RUNNING.equals(state) ? null : "2026-10-13T10:00:05Z",
                CodeGraphJobs.FAILED.equals(state) ? 1 : 0, tail.isEmpty() ? null : tail.get(tail.size() - 1), tail);
    }

    @Test
    void aFullBuildIsBuiltWithTheCountsGraphifyWrote() throws IOException {
        assertEquals(new GraphifyCommand.Result(GraphifyCommand.BUILT, "5 nodes, 7 edges, 2 communities"),
                GraphifyCommand.result(ended("full", CodeGraphJobs.OK, fixture("full"))));
    }

    @Test
    void anUpdateThatChangedNothingIsAlreadyCurrent() throws IOException {
        assertEquals(new GraphifyCommand.Result(GraphifyCommand.CURRENT, null),
                GraphifyCommand.result(ended("update", CodeGraphJobs.OK, fixture("update-current"))));
    }

    @Test
    void anUpdateThatChangedTheGraphIsUpdatedWithTheNewCounts() throws IOException {
        assertEquals(new GraphifyCommand.Result(GraphifyCommand.UPDATED, "6 nodes, 8 edges, 2 communities"),
                GraphifyCommand.result(ended("update", CodeGraphJobs.OK, fixture("update-changed"))));
    }

    /**
     * Fix round, I1: an update is updated only with the size graphify prints
     * after a rebuild, and current only with its line that nothing changed.
     * A reworded line, an empty output or both signs at once leave it finished.
     */
    @Test
    void anUpdateWithoutClearEvidenceIsOnlyFinished() throws IOException {
        List<String> reworded = fixture("update-current").stream()
                .map(line -> line.replace(GraphifyCommand.NO_CHANGES, "Nothing in the code graph moved")).toList();
        assertTrue(fixture("update-current").stream().anyMatch(line -> line.contains(GraphifyCommand.NO_CHANGES)),
                "premise: the fixture carries the line the rewording replaces");
        assertEquals(new GraphifyCommand.Result(GraphifyCommand.FINISHED, null),
                GraphifyCommand.result(ended("update", CodeGraphJobs.OK, reworded)));
        assertEquals(new GraphifyCommand.Result(GraphifyCommand.FINISHED, null),
                GraphifyCommand.result(ended("update", CodeGraphJobs.OK, List.of())));
        List<String> both = new ArrayList<>(fixture("update-changed"));
        both.add("[graphify watch] " + GraphifyCommand.NO_CHANGES + "; outputs left untouched.");
        assertEquals(new GraphifyCommand.Result(GraphifyCommand.FINISHED, null),
                GraphifyCommand.result(ended("update", CodeGraphJobs.OK, both)));
    }

    /** Fix round, I1: the size is the evidence, whatever words stand before it. */
    @Test
    void anUpdateIsUpdatedByTheSizeItPrintsEvenWhenTheWordsAroundItChange() throws IOException {
        List<String> reworded = fixture("update-changed").stream()
                .map(line -> line.replace("Rebuilt:", "Graph written:")).toList();
        assertEquals(new GraphifyCommand.Result(GraphifyCommand.UPDATED, "6 nodes, 8 edges, 2 communities"),
                GraphifyCommand.result(ended("update", CodeGraphJobs.OK, reworded)));
    }

    @Test
    void aFailedBuildIsFailedAndARunningOneHasNoResultYet() throws IOException {
        assertEquals(new GraphifyCommand.Result(GraphifyCommand.FAILED, null),
                GraphifyCommand.result(ended("full", CodeGraphJobs.FAILED, List.of("Traceback", "boom"))));
        assertNull(GraphifyCommand.result(ended("full", CodeGraphJobs.RUNNING, fixture("full"))));
        assertNull(GraphifyCommand.result(null));
    }

    /** Card 587, criterion 6: the install line is the backend's own, not a second copy. */
    @Test
    void theInstallLineIsTheBackendsOwn() {
        assertEquals(dev.spectroscope.core.codegraph.CodeGraphBackend.GRAPHIFY.install(), GraphifyCommand.INSTALL_LINE);
    }

    @Test
    void theRealGraphifyStillPrintsWhatTheResultReads(@TempDir Path folder) throws Exception {
        ToolPath.Lookup graphify = ToolPath.locate("graphify");
        Assumptions.assumeTrue(graphify.isFound(), "graphify is not installed on this machine");
        Files.writeString(folder.resolve("m.py"), "def a():\n    return b()\n\ndef b():\n    return 1\n");
        Files.writeString(folder.resolve("app.py"), "from m import a\n\ndef main():\n    print(a())\n");

        GraphifyCommand.Result built = run(graphify.found(), folder, GraphifyCommand.Mode.FULL);
        assertEquals(GraphifyCommand.BUILT, built.kind());
        assertTrue(built.counts() != null && built.counts().matches("\\d+ nodes, \\d+ edges, \\d+ communities"),
                String.valueOf(built.counts()));

        assertEquals(GraphifyCommand.CURRENT, run(graphify.found(), folder, GraphifyCommand.Mode.UPDATE).kind());

        Files.writeString(folder.resolve("m.py"), "\ndef c():\n    return 2\n", java.nio.file.StandardOpenOption.APPEND);
        GraphifyCommand.Result updated = run(graphify.found(), folder, GraphifyCommand.Mode.UPDATE);
        assertEquals(GraphifyCommand.UPDATED, updated.kind());
        assertTrue(updated.counts() != null, "an update that changed the graph says its size");
    }

    /** The steps a build runs, one after the other, read as the jobs read them. */
    private static GraphifyCommand.Result run(String binary, Path folder, GraphifyCommand.Mode mode) throws Exception {
        List<String> lines = new ArrayList<>();
        boolean ok = true;
        for (List<String> argv : GraphifyCommand.steps(binary, folder, mode, null)) {
            Process process = new ProcessBuilder(argv).directory(folder.toFile()).redirectErrorStream(true).start();
            process.getOutputStream().close();
            try (BufferedReader out = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                out.lines().forEach(lines::add);
            }
            ok &= process.waitFor(60, TimeUnit.SECONDS) && process.exitValue() == 0;
        }
        List<String> tail = lines.subList(Math.max(0, lines.size() - CodeGraphJobs.TAIL), lines.size());
        return GraphifyCommand.result(ended(mode == GraphifyCommand.Mode.FULL ? "full" : "update",
                ok ? CodeGraphJobs.OK : CodeGraphJobs.FAILED, List.copyOf(tail)));
    }
}
