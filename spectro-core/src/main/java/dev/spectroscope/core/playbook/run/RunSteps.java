package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.tools.ToolOutput;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Card 586: builds the {@code run_step} lines of one run and numbers the
 * entries of each node, so a loop shows as a second entry of the same node.
 */
final class RunSteps {

    /** The longest input, output, error or detail a line carries: the run view shows the start of a text, the chat holds it whole. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    static final int TEXT_CAP = 4_000;

    static final String DONE = "done";
    static final String FAILED = "failed";
    static final String STOPPED = "stopped";

    /** What a step or decision starts with. */
    record Start(String performer, String role, String provider, String model, boolean picked, String input,
                 List<RunEvent.RunDoc> reads, Integer round, Integer maxRounds) {
    }

    /** What a step or decision ends with. */
    record End(String status, long durationMs, String childId, List<String> children, String output,
               List<RunEvent.RunDoc> documents, String label, String error, Integer round, Integer maxRounds) {
    }

    private final String runId;
    private final String runKind;
    /** Concurrent, so that steps entered from parallel threads lose no count. */
    private final Map<String, Integer> entries = new ConcurrentHashMap<>();

    RunSteps(String runId, String runKind) {
        this.runId = runId;
        this.runKind = runKind;
    }

    /** @param node a node id; @return 1 for its first entry, then 2, 3 */
    int enter(String node) {
        return entries.merge(node, 1, Integer::sum);
    }

    /**
     * @param workspace the run's folder, as the host names it; its real path is
     *                  fingerprinted, see {@link #fingerprint}
     */
    RunEvent.RunStep runStart(String name, String task, List<RunEvent.RunNode> nodes, Path workspace) {
        return new RunEvent.RunStep(PlaybookRunner.AGENT_ID, runId, runKind, RunEvent.RunStep.RUN_START,
                name, task, nodes == null ? null : List.copyOf(nodes), null, null, null, null, null, null, null,
                null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null, null, null, null, now(), fingerprint(workspace));
    }

    /**
     * Card 586, straggler M5: the fingerprint of a folder's real path, so a
     * document route can tell the run's folder from another one later bound to
     * the same session. The path itself never reaches the line.
     *
     * @param workspace the folder, possibly through a link; null when the host has none
     * @return the fingerprint, or null when the folder has no real path
     */
    static String fingerprint(Path workspace) {
        if (workspace == null) {
            return null;
        }
        try {
            return RunEvent.RunStep.fingerprintOf(workspace.toRealPath());
        } catch (IOException gone) {
            return null;
        }
    }

    RunEvent.RunStep stepStart(String node, String name, String kind, int entry, Start s) {
        return new RunEvent.RunStep(PlaybookRunner.AGENT_ID, runId, runKind, RunEvent.RunStep.STEP_START,
                name, null, null, node, kind, entry, s.performer(), s.role(), s.provider(), s.model(),
                s.picked() ? Boolean.TRUE : null, cut(s.input()), length(s.input()), emptyToNull(s.reads()),
                s.round(), s.maxRounds(), null, null, null, null, null, null, null, null, null, null, null, null,
                now());
    }

    RunEvent.RunStep stepEnd(String node, String name, String kind, int entry, End e) {
        return new RunEvent.RunStep(PlaybookRunner.AGENT_ID, runId, runKind, RunEvent.RunStep.STEP_END,
                name, null, null, node, kind, entry, null, null, null, null, null, null, null, null,
                e.round(), e.maxRounds(), e.status(), e.durationMs(), e.childId(), emptyToNull(e.children()),
                cut(e.output()), length(e.output()), emptyToNull(e.documents()), e.label(), cut(e.error()),
                null, null, null, now());
    }

    RunEvent.RunStep runEnd(String stopReason, String result, String detail, long durationMs) {
        return new RunEvent.RunStep(PlaybookRunner.AGENT_ID, runId, runKind, RunEvent.RunStep.RUN_END,
                null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
                null, durationMs, null, null, null, null, null, null, null, stopReason, result, cut(detail), now());
    }

    /** @param text any text or null; @return at most its first {@link #TEXT_CAP} characters, never half of a surrogate pair */
    static String cut(String text) {
        return text == null ? null : ToolOutput.clip(text, TEXT_CAP);
    }

    private static Integer length(String text) {
        return text == null ? null : text.length();
    }

    private static <T> List<T> emptyToNull(List<T> list) {
        return list == null || list.isEmpty() ? null : List.copyOf(list);
    }

    private static long now() {
        return System.currentTimeMillis();
    }
}
