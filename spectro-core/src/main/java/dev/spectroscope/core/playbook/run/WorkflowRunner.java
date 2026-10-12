package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.peer.PeerFrames;
import dev.spectroscope.core.playbook.Workflow;
import dev.spectroscope.core.subagents.AgentType;
import dev.spectroscope.core.subagents.SubagentManager;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Card 506: runs one workflow file in the session that started it. A
 * {@code prompt} step is a chat turn through the host; a {@code fanout} step
 * starts its children with {@code spawn_agents} in the background, waits for
 * them with no model turn open, collects them with {@code wait_agents} and
 * hands the joined results to one summariser child; an {@code end} step ends
 * the run. The runner writes the session's sidecar and nothing else: no file
 * goes into the working folder.
 */
public final class WorkflowRunner {

    /** The stop reason of a run whose repeating step used up its rounds without its text. */
    public static final String EXHAUSTED = "exhausted";

    /**
     * The label of a summariser's task message, followed by the step id. The
     * page reads it to draw the summariser's message in full in the main
     * thread as the run's answer ({@code spectro-web/src/state/peerMessages.ts}).
     */
    public static final String SUMMARISER_LABEL_PREFIX = "workflow:";

    /**
     * @param workflow the file as read
     * @param file     its path below the playbook folder
     * @param hash     the hash the module showed and the start matched
     * @param runId    12 hex characters
     * @param input    what the operator typed beside Run; may be empty
     * @param lang     {@code de} or {@code en}, for the texts that carry both
     * @param recorder the session's sidecar
     * @param signal   the run's signal; Stop cancels it
     */
    public record Setup(Workflow workflow, String file, String hash, String runId, String input, String lang,
                        PlaybookRecorder recorder, CancelSignal signal) {
    }

    /**
     * @param runId      the run
     * @param stopReason {@link RunStop#DONE}, {@link RunStop#ABORTED}, {@link RunStop#STEP_FAILED} or {@link #EXHAUSTED}
     * @param result     the end's result label when the run reached an end, else null
     * @param steps      how many step bodies ran, rounds counted
     * @param answer     the last step's answer
     * @param detail     what a person reads about the stop, or null
     */
    public record Outcome(String runId, String stopReason, String result, int steps, String answer, String detail) {
    }

    private final Setup setup;
    private final PlaybookHost host;
    private final SubagentManager manager;
    private int ran;

    /**
     * @param setup   the run
     * @param host    the session that runs it
     * @param manager the session's subagent manager
     */
    public WorkflowRunner(Setup setup, PlaybookHost host, SubagentManager manager) {
        this.setup = setup;
        this.host = host;
        this.manager = manager;
    }

    /** @return how the run ended; never throws */
    public Outcome run() {
        long began = System.currentTimeMillis();
        Workflow w = setup.workflow();
        Map<String, Object> start = new LinkedHashMap<>();
        start.put("run", setup.runId());
        start.put("workflow", w.name());
        start.put("file", setup.file());
        start.put("hash", setup.hash());
        start.put("inputChars", setup.input() == null ? 0 : setup.input().length());
        setup.recorder().record("workflow_start", start);
        String previous = "";
        try {
            for (Workflow.Step step : w.steps()) {
                stopIfCancelled(step.id());
                if (step instanceof Workflow.End end) {
                    return end(RunStop.DONE, end.result(), previous, null, began);
                }
                String until = step instanceof Workflow.Prompt p ? p.repeatUntil() : ((Workflow.Fanout) step).repeatUntil();
                Integer max = step instanceof Workflow.Prompt p ? p.maxRounds() : ((Workflow.Fanout) step).maxRounds();
                int rounds = until == null ? 1 : max;
                boolean met = until == null;
                for (int round = 1; round <= rounds; round++) {
                    stopIfCancelled(step.id());
                    previous = runStep(step, previous, round);
                    if (until != null && previous.contains(until)) {
                        met = true;
                        break;
                    }
                }
                if (!met) {
                    return end(EXHAUSTED, null, previous, step.id() + ": " + rounds
                            + " rounds ran and the answer never held \"" + until + "\"", began);
                }
            }
            return end(RunStop.DONE, null, previous, null, began);
        } catch (RunStopped stopped) {
            return end(stopped.reason(), null, previous, stopped.getMessage(), began);
        } catch (RuntimeException failure) {
            return end(setup.signal().isCancelled() ? RunStop.ABORTED : RunStop.STEP_FAILED, null, previous,
                    String.valueOf(failure.getMessage()), began);
        }
    }

    private String runStep(Workflow.Step step, String previous, int round) {
        ran++;
        long t0 = System.currentTimeMillis();
        CancelSignal stepSignal = new CancelSignal();
        Runnable unhook = setup.signal().onCancel(stepSignal::cancel);
        String answer = null;
        List<String> children = new ArrayList<>();
        try {
            answer = switch (step) {
                case Workflow.Prompt p -> prompt(p, previous, stepSignal);
                case Workflow.Fanout f -> fanout(f, previous, stepSignal, children);
                case Workflow.End e -> previous;
            };
            record(step, round, true, null, children, t0);
            return answer;
        } catch (RunStopped stopped) {
            record(step, round, false, stopped.getMessage(), children, t0);
            throw stopped;
        } catch (RuntimeException failure) {
            record(step, round, false, String.valueOf(failure.getMessage()), children, t0);
            throw failure;
        } finally {
            unhook.run();
        }
    }

    private String prompt(Workflow.Prompt p, String previous, CancelSignal signal) {
        String text = fill(p.template().in(setup.lang()), previous, null);
        PlaybookHost.ChatTurn turn = host.chatTurn(text, text, signal);
        stopIfCancelled(p.id());
        if ("aborted".equals(turn.stopReason())) {
            throw new RunStopped(RunStop.ABORTED, p.id() + ": the chat turn was aborted");
        }
        if ("error".equals(turn.stopReason())) {
            throw new RunStopped(RunStop.STEP_FAILED, p.id() + ": " + turn.lastText());
        }
        return turn.lastText();
    }

    private String fanout(Workflow.Fanout f, String previous, CancelSignal signal, List<String> children) {
        List<SubagentManager.Spawn> spawns = new ArrayList<>();
        for (Workflow.Agent a : f.agents()) {
            spawns.add(new SubagentManager.Spawn(a.roleOrDefault(), fill(a.task().in(setup.lang()), previous, null)));
        }
        String results;
        try (SubagentManager.Orchestration o = manager.orchestrate(host::emit, signal)) {
            String started = o.spawn(spawns);
            if (started.startsWith("ERROR:")) {
                throw new RunStopped(RunStop.STEP_FAILED, f.id() + ": " + started);
            }
            children.addAll(o.children());
            o.awaitChildren();
            stopIfCancelled(f.id());
            results = o.collect();
        }
        stopIfCancelled(f.id());
        if (f.join() == null) {
            return results;
        }
        String task = fill(f.join().task().in(setup.lang()), previous, results);
        AgentType role = AgentType.fromId(f.join().roleOrDefault()).orElse(AgentType.EXPLORE);
        SubagentManager.StepResult summary = manager.runStep(new SubagentManager.StepChild(role, task, task,
                SUMMARISER_LABEL_PREFIX + f.id(), null), host::emit, signal);
        if (summary.childId() != null) {
            children.add(summary.childId());
        }
        stopIfCancelled(f.id());
        if (summary.failed()) {
            throw new RunStopped(RunStop.STEP_FAILED, f.id() + ": the summariser failed: " + summary.outcome());
        }
        String answer = summary.answer().strip();
        // The summary reaches the chat as a message the run received from its
        // summariser, the block card 503 draws, and the last one of the run.
        host.emit(new RunEvent.AgentMessage(summary.childId(), manager.parentAgentId(), "peer", "received",
                answer, PeerFrames.newMsgId(), System.currentTimeMillis()));
        return answer;
    }

    private static final java.util.regex.Pattern PLACEHOLDER =
            java.util.regex.Pattern.compile("\\{\\{\\s*(input|previous|folder|results)\\s*}}");

    /**
     * Fills the placeholders the reader allowed in one pass over the template,
     * so a filled value is never scanned again; {@code {{results}}} only where
     * results is given.
     */
    private String fill(String template, String previous, String results) {
        java.util.regex.Matcher m = PLACEHOLDER.matcher(template);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String value = switch (m.group(1)) {
                case "input" -> setup.input() == null ? "" : setup.input();
                case "previous" -> previous;
                case "folder" -> host.workspace().toString();
                default -> results == null ? m.group() : results;
            };
            m.appendReplacement(out, java.util.regex.Matcher.quoteReplacement(value));
        }
        m.appendTail(out);
        return out.toString();
    }

    private void stopIfCancelled(String stepId) {
        if (setup.signal().isCancelled()) {
            throw new RunStopped(RunStop.ABORTED, "stopped during " + stepId);
        }
    }

    private void record(Workflow.Step step, int round, boolean ok, String error, List<String> children, long t0) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("run", setup.runId());
        f.put("step", step.id());
        f.put("kind", step instanceof Workflow.Prompt ? "prompt" : "fanout");
        f.put("round", round);
        f.put("children", List.copyOf(children));
        f.put("ok", ok);
        f.put("error", error);
        f.put("durationMs", System.currentTimeMillis() - t0);
        setup.recorder().record("workflow_step", f);
    }

    private Outcome end(String stop, String result, String answer, String detail, long began) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("run", setup.runId());
        f.put("stopReason", stop);
        f.put("result", result);
        f.put("detail", detail);
        f.put("steps", ran);
        f.put("durationMs", System.currentTimeMillis() - began);
        setup.recorder().record("workflow_end", f);
        return new Outcome(setup.runId(), stop, result, ran, answer, detail);
    }
}
