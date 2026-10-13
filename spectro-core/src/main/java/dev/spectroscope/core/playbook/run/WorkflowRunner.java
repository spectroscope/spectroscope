package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.peer.PeerFrames;
import dev.spectroscope.core.playbook.Playbook;
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
 *
 * <p>Card 586: the run view beside the chat reads the run from its
 * {@code run_step} lines: {@code run_start} with the step list, one
 * {@code step_start} and one {@code step_end} for every round of a step, and
 * {@code run_end}, on every way out.
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
    private final RunSteps lines;
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
        this.lines = new RunSteps(setup.runId(), "workflow");
    }

    /**
     * @return how the run ended. A failing step ends the run with an outcome;
     *         a throw no step handles (from the host, the sidecar or an Error)
     *         goes on to the caller after the run's run_end line.
     */
    public Outcome run() {
        long began = System.currentTimeMillis();
        Workflow w = setup.workflow();
        boolean opened = false;
        Outcome ended = null;
        Throwable thrown = null;
        try {
            Map<String, Object> start = new LinkedHashMap<>();
            start.put("run", setup.runId());
            start.put("workflow", w.name());
            start.put("file", setup.file());
            start.put("hash", setup.hash());
            start.put("inputChars", setup.input() == null ? 0 : setup.input().length());
            setup.recorder().record("workflow_start", start);
            host.emit(lines.runStart(w.name(), task(), nodes(w), host.workspace()));
            opened = true;
            ended = steps(w, began);
            return ended;
        } catch (RuntimeException | Error broken) {
            thrown = broken;
            throw broken;
        } finally {
            // Card 586: the one place run_end goes out, so every run ends once,
            // also one that threw before its start line or past its steps.
            if (!opened) {
                host.emit(lines.runStart(w.name(), task(), nodes(w), host.workspace()));
            }
            long took = System.currentTimeMillis() - began;
            host.emit(ended != null ? lines.runEnd(ended.stopReason(), ended.result(), ended.detail(), took)
                    : lines.runEnd(setup.signal().isCancelled() ? RunStop.ABORTED : RunStop.STEP_FAILED, null,
                            errorOf(thrown), took));
        }
    }

    /**
     * The steps in order. Every way out records workflow_end through
     * {@link #end}, except an Error and a throw out of end(...) itself.
     */
    private Outcome steps(Workflow w, long began) {
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
                    previous = runStep(step, previous, round, until == null ? null : max);
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

    /**
     * One round of a step. Card 586: the round is one entry of the step on the
     * run view, and its end goes out on every way out of here. The start and
     * the end of a step that repeats carry its round and its ceiling; a step
     * that does not repeat carries neither.
     *
     * @param round     1 for a step that does not repeat; the sidecar records it
     * @param maxRounds the step's ceiling when it repeats, else null
     */
    private String runStep(Workflow.Step step, String previous, int round, Integer maxRounds) {
        if (step instanceof Workflow.End) {
            return previous; // an end runs no body; steps() ends the run on it
        }
        ran++;
        long t0 = System.currentTimeMillis();
        CancelSignal stepSignal = new CancelSignal();
        Runnable unhook = setup.signal().onCancel(stepSignal::cancel);
        String kind = kindOf(step);
        String name = nameOf(step);
        int entry = lines.enter(step.id());
        Integer lineRound = maxRounds == null ? null : round;
        String input = null;
        String answer = null;
        List<String> children = new ArrayList<>();
        boolean opened = false;
        boolean closed = false;
        Throwable thrown = null;
        try {
            List<String> tasks = step instanceof Workflow.Fanout f ? tasks(f, previous) : List.of();
            input = step instanceof Workflow.Prompt p ? fill(p.template().in(setup.lang()), previous, null)
                    : String.join("\n", tasks);
            Playbook.ModelRef chat = host.chatModel();
            host.emit(lines.stepStart(step.id(), name, kind, entry, new RunSteps.Start(performerOf(step), null,
                    chat.provider(), chat.model(), false, input, List.of(), lineRound, maxRounds)));
            opened = true;
            answer = switch (step) {
                case Workflow.Prompt p -> prompt(p, input, stepSignal);
                case Workflow.Fanout f -> fanout(f, tasks, previous, stepSignal, children);
                case Workflow.End e -> previous; // returned above
            };
            record(step, round, true, null, children, t0);
            host.emit(lines.stepEnd(step.id(), name, kind, entry, new RunSteps.End(RunSteps.DONE,
                    System.currentTimeMillis() - t0, null, children, answer, List.of(), null, null, lineRound,
                    maxRounds)));
            closed = true;
            return answer;
        } catch (RunStopped stopped) {
            thrown = stopped;
            record(step, round, false, stopped.getMessage(), children, t0);
            throw stopped;
        } catch (RuntimeException failure) {
            thrown = failure;
            record(step, round, false, String.valueOf(failure.getMessage()), children, t0);
            throw failure;
        } catch (Error broken) {
            thrown = broken;
            throw broken;
        } finally {
            try {
                if (!closed) {
                    if (!opened) {
                        // The round failed before its start line went out: the start
                        // goes out first, without a model, so the end never stands alone.
                        host.emit(lines.stepStart(step.id(), name, kind, entry, new RunSteps.Start(
                                performerOf(step), null, null, null, false, input, List.of(), lineRound, maxRounds)));
                    }
                    host.emit(lines.stepEnd(step.id(), name, kind, entry, new RunSteps.End(statusOf(thrown),
                            System.currentTimeMillis() - t0, null, children, answer, List.of(), null,
                            errorOf(thrown), lineRound, maxRounds)));
                }
            } finally {
                unhook.run();
            }
        }
    }

    private String prompt(Workflow.Prompt p, String text, CancelSignal signal) {
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

    /** Card 586: the filled tasks of a fan-out's children, in the order of its agents. */
    private List<String> tasks(Workflow.Fanout f, String previous) {
        return f.agents().stream().map(a -> fill(a.task().in(setup.lang()), previous, null)).toList();
    }

    /** @param tasks the filled tasks, one per agent, in the order of {@code f.agents()} */
    private String fanout(Workflow.Fanout f, List<String> tasks, String previous, CancelSignal signal,
                          List<String> children) {
        List<SubagentManager.Spawn> spawns = new ArrayList<>();
        for (int i = 0; i < f.agents().size(); i++) {
            spawns.add(new SubagentManager.Spawn(f.agents().get(i).roleOrDefault(), tasks.get(i)));
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
        // summariser, the block card 503 draws. The fan-out's step_end follows it.
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

    /** Card 586: what the run was asked, for run_start; null when the input is blank, as for a playbook run. */
    private String task() {
        String input = setup.input();
        return input == null || input.isBlank() ? null : input;
    }

    /** Card 586: the run's forward path, its steps in order without the end. */
    private static List<RunEvent.RunNode> nodes(Workflow w) {
        return w.steps().stream().filter(s -> !(s instanceof Workflow.End))
                .map(s -> new RunEvent.RunNode(s.id(), nameOf(s), kindOf(s))).toList();
    }

    /** Card 586: {@code prompt} or {@code fanout}. */
    private static String kindOf(Workflow.Step step) {
        return step instanceof Workflow.Prompt ? "prompt" : "fanout";
    }

    /** Card 586: a fan-out's label, else the step id. */
    private static String nameOf(Workflow.Step step) {
        return step instanceof Workflow.Fanout f && f.label() != null ? f.label() : step.id();
    }

    /** Card 586: the chat works on a prompt, children on a fan-out. */
    private static String performerOf(Workflow.Step step) {
        return step instanceof Workflow.Prompt ? "chat" : "child";
    }

    /** Card 586: stopped when the owner pressed Stop or the turn was aborted, else failed. */
    private String statusOf(Throwable thrown) {
        return setup.signal().isCancelled()
                || (thrown instanceof RunStopped stopped && RunStop.ABORTED.equals(stopped.reason()))
                ? RunSteps.STOPPED : RunSteps.FAILED;
    }

    /** Card 586: what a person reads about a throw, its type when it carries no message. */
    private static String errorOf(Throwable thrown) {
        if (thrown == null) {
            return null;
        }
        return thrown.getMessage() != null ? thrown.getMessage() : thrown.toString();
    }
}
