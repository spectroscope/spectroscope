package dev.spectroscope.core.playbook.run;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.graph.Channel;
import dev.spectroscope.core.graph.FanOutPath;
import dev.spectroscope.core.graph.GraphArtifact;
import dev.spectroscope.core.graph.GraphRecursionException;
import dev.spectroscope.core.graph.GraphState;
import dev.spectroscope.core.graph.Node;
import dev.spectroscope.core.graph.RunConfig;
import dev.spectroscope.core.graph.StateGraph;
import dev.spectroscope.core.graph.StateSchema;
import dev.spectroscope.core.graph.StateUpdate;
import dev.spectroscope.core.playbook.AgentFile;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.subagents.AgentType;
import dev.spectroscope.core.subagents.SubagentManager;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/**
 * Runs one playbook on the StateGraph engine. Steps and decisions are nodes,
 * arrows are edges, ends set the result. A step runs on the model its choice
 * names, as a chat turn through the host or as a child through runStep (an
 * {@code agent:<name>} role runs on the pinned agent file's type and preamble); a
 * decision runs its check and routes by label. The engine writes the graph
 * artifact; this class writes the plan and the sidecar.
 */
public final class PlaybookRunner {

    public static final String AGENT_ID = "playbook";

    /**
     * @param pinned      the bytes this run holds
     * @param runId       12 hex characters
     * @param graphFile   where the engine writes the lifecycle
     * @param recorder    the session's sidecar
     * @param signal      the run's signal; Stop cancels it
     * @param sessionMode the session's permission mode at start, for the sidecar
     * @param task        what the owner asked the run to do (card 554); every step prompt names
     *                    it, the run start records it; null or blank when the run was started
     *                    without one
     * @param picks       card 584: the model the owner picked in the start sheet per node id, for
     *                    this run only; a picked node runs on its pick without fallbacks. Checked
     *                    by {@link ModelPicks#refusal} before the run starts; empty for none
     */
    public record Setup(PinnedPlaybook pinned, String runId, Path graphFile, PlaybookRecorder recorder,
                        CancelSignal signal, String sessionMode, String task,
                        Map<String, Playbook.ModelRef> picks) {

        /**
         * The setup as the run reads it.
         *
         * @param task  the task as typed; blank reads as none and leaves the step prompts as they were
         * @param picks the picks; null reads as none, and the run holds its own copy
         */
        public Setup {
            task = task == null || task.isBlank() ? null : task.strip();
            picks = picks == null ? Map.of() : Map.copyOf(picks);
        }

        /**
         * The card 554 shape: a run with a task and no picks.
         *
         * @param pinned      the bytes this run holds
         * @param runId       12 hex characters
         * @param graphFile   where the engine writes the lifecycle
         * @param recorder    the session's sidecar
         * @param signal      the run's signal; Stop cancels it
         * @param sessionMode the session's permission mode at start, for the sidecar
         * @param task        what the owner asked the run to do, or null
         */
        public Setup(PinnedPlaybook pinned, String runId, Path graphFile, PlaybookRecorder recorder,
                     CancelSignal signal, String sessionMode, String task) {
            this(pinned, runId, graphFile, recorder, signal, sessionMode, task, Map.of());
        }

        /**
         * The pre-card-554 shape: a run without a task.
         *
         * @param pinned      the bytes this run holds
         * @param runId       12 hex characters
         * @param graphFile   where the engine writes the lifecycle
         * @param recorder    the session's sidecar
         * @param signal      the run's signal; Stop cancels it
         * @param sessionMode the session's permission mode at start, for the sidecar
         */
        public Setup(PinnedPlaybook pinned, String runId, Path graphFile, PlaybookRecorder recorder,
                     CancelSignal signal, String sessionMode) {
            this(pinned, runId, graphFile, recorder, signal, sessionMode, null);
        }
    }

    /**
     * @param runId      the run
     * @param stopReason one of {@link RunStop}
     * @param result     the end's result when the run reached an end, else null
     * @param nodes      how many node bodies ran
     * @param detail     what a person reads about the stop
     */
    public record Outcome(String runId, String stopReason, String result, int nodes, String detail) {
    }

    private final Setup setup;
    private final Playbook p;
    private final PlaybookHost host;
    private final SubagentManager manager;
    private final Function<String, Optional<String>> hostRefusal;
    private final Set<String> ends;
    private final Map<String, String> status = new LinkedHashMap<>();
    private final Set<String> cloudConfirmed = new HashSet<>();
    private final AtomicInteger calls = new AtomicInteger();
    private final AtomicInteger ran = new AtomicInteger();
    private final RunSteps lines;
    private boolean privateRan;

    public PlaybookRunner(Setup setup, PlaybookHost host, SubagentManager manager,
                          Function<String, Optional<String>> hostRefusal) {
        this.setup = setup;
        this.p = setup.pinned().playbook();
        this.host = host;
        this.manager = manager;
        this.hostRefusal = hostRefusal;
        this.ends = PlaybookWalk.endIds(p);
        this.lines = new RunSteps(setup.runId(), "playbook");
        PlaybookWalk.forwardPath(p).forEach(id -> status.put(id, "pending"));
    }

    /** @return 12 lower hex characters, the engine's own run id shape */
    public static String newRunId() {
        String hex = UUID.randomUUID().toString().replace("-", "");
        return hex.substring(0, 12);
    }

    /**
     * The refusals of a run without picks.
     *
     * @param pinned the pinned playbook
     * @param canAsk whether a person can answer here
     * @param kindOf provider kind by name, without a request
     * @return every reason this playbook may not start; empty when it may
     */
    public static List<String> refusals(PinnedPlaybook pinned, boolean canAsk, Function<String, String> kindOf) {
        return refusals(pinned, canAsk, kindOf, Map.of());
    }

    /**
     * Card 584: the refusals of a run with picks. A private step is refused
     * on the provider it runs on in this run: its pick when it has one.
     *
     * @param pinned the pinned playbook
     * @param canAsk whether a person can answer here
     * @param kindOf provider kind by name, without a request
     * @param picks  this run's picks by node id
     * @return every reason this playbook may not start; empty when it may
     */
    public static List<String> refusals(PinnedPlaybook pinned, boolean canAsk, Function<String, String> kindOf,
                                        Map<String, Playbook.ModelRef> picks) {
        return collect(pinned, canAsk, kindOf, picks == null ? Map.of() : picks);
    }

    /**
     * Card 584: the refusals the start sheet lists, every one but a private
     * step on a cloud provider. The sheet names that one on the step's row,
     * where a pick of a local model lifts it.
     *
     * @param pinned the pinned playbook
     * @param canAsk whether a person can answer here
     * @return every reason a model pick cannot lift; empty when there is none
     */
    public static List<String> refusalsBesideModels(PinnedPlaybook pinned, boolean canAsk) {
        return collect(pinned, canAsk, null, Map.of());
    }

    /** The refusals; the private step rule only when {@code kindOf} is given. */
    private static List<String> collect(PinnedPlaybook pinned, boolean canAsk, Function<String, String> kindOf,
                                        Map<String, Playbook.ModelRef> picks) {
        Playbook p = pinned.playbook();
        List<String> out = new ArrayList<>();
        pinned.missingSkills().forEach(name -> out.add("skill not found: " + name));
        out.addAll(pinned.missingAgents().values());
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Step s) {
                if ("extended".equals(s.permission())) {
                    out.add(s.id() + ": a playbook may not set permission extended");
                }
                Playbook.ModelRef ref = ModelPicks.choiceOf(p, s.id(), s.model(), picks).primary();
                if (kindOf != null && "private".equals(s.privacy())) {
                    if ("cloud".equals(kindOf.apply(ref.provider()))) {
                        out.add(s.id() + ": a private step may not run on the cloud provider " + ref.provider());
                    } else if (ModelResolver.cloudModel(ref)) {
                        out.add(s.id() + ": a private step may not run on the cloud model " + ref.provider() + " "
                                + ref.model());
                    }
                }
                if (s.nod() && !canAsk) {
                    out.add(s.id() + ": nobody can approve the handover here");
                }
            } else if (n instanceof Playbook.Decision d) {
                Playbook.Check c = p.checks().get(d.check());
                if ("human".equals(c.kind()) && !canAsk) {
                    out.add(d.id() + ": nobody can answer this check here");
                }
                if ("human".equals(c.kind()) && CheckText.labels(c).size() > 4) {
                    out.add(d.id() + ": a human check may offer at most four labels");
                }
            }
        }
        return out;
    }

    /** @return the engine graph of this playbook */
    StateGraph graph() {
        StateGraph g = new StateGraph(StateSchema.of(
                Channel.lastWriteWins("outcome"),
                Channel.lastWriteWins("result"),
                Channel.reducing("loops", PlaybookRunner::merge),
                Channel.reducing("documents", PlaybookRunner::merge)));
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Step s) {
                g.addNode(s.id(), (Node) state -> step(s, state));
                Playbook.Arrow a = PlaybookWalk.arrowFrom(p, s.id(), null);
                g.addEdge(s.id(), target(a.to()));
            } else if (n instanceof Playbook.Decision d) {
                g.addNode(d.id(), (Node) state -> decide(d, state));
                Map<String, String> map = new LinkedHashMap<>();
                for (Playbook.Arrow a : PlaybookWalk.arrowsFrom(p, d.id())) {
                    map.put(a.on(), target(a.to()));
                }
                g.addConditionalEdges(d.id(), (FanOutPath) state -> state.get("outcome"), map);
            }
        }
        g.addEdge(StateGraph.START, p.start());
        return g;
    }

    /**
     * @return how the run ended. A throw outside the graph (from the host or
     *         the sidecar) goes on to the caller after the run's run_end line.
     */
    public Outcome run() {
        long began = System.currentTimeMillis();
        boolean opened = false;
        String stop = null;
        String result = null;
        String detail = null;
        try {
            Playbook.ModelRef chatBefore = host.chatModel();
            Map<String, Object> start = new LinkedHashMap<>();
            start.put("run", setup.runId());
            start.put("playbook", p.id());
            start.put("dir", setup.pinned().dir().toString());
            start.put("hash", setup.pinned().hash());
            start.put("mode", setup.sessionMode());
            start.put("chat", Map.of("provider", chatBefore.provider(), "model", chatBefore.model()));
            if (setup.task() != null) {
                start.put("task", setup.task());
            }
            if (!setup.picks().isEmpty()) {
                // Card 584: the picks of this run, so a replay shows what ran on another model than the playbook's.
                Map<String, Object> picks = new java.util.TreeMap<>();
                setup.picks().forEach((node, ref) -> {
                    Map<String, Object> pick = new LinkedHashMap<>();
                    pick.put("provider", ref.provider());
                    pick.put("model", ref.model());
                    picks.put(node, pick);
                });
                start.put("picks", picks);
            }
            setup.recorder().record("playbook_start", start);
            host.emit(RunEvent.PlaybookProgress.started(AGENT_ID, setup.runId(), p.name(), setup.task(),
                    System.currentTimeMillis()));
            List<String> refused = refusals(setup.pinned(), host.asker() != null, host::kindOf, setup.picks());
            host.emit(lines.runStart(p.name(), setup.task(), forwardNodes(), host.workspace()));
            opened = true;
            if (!refused.isEmpty()) {
                stop = RunStop.REFUSED;
                detail = String.join("; ", refused);
                return end(stop, null, detail, began);
            }
            emitPlan();
            try (GraphArtifact artifact = new GraphArtifact(setup.graphFile())) {
                GraphState out = graph().compile(artifact).invoke(GraphState.empty(), RunConfig.defaults());
                result = (String) out.get("result");
                stop = RunStop.DONE;
            } catch (RunStopped stopped) {
                stop = stopped.reason();
                detail = stopped.getMessage();
            } catch (GraphRecursionException loop) {
                stop = RunStop.RECURSION_LIMIT;
                detail = loop.getMessage();
            } catch (Exception failure) {
                stop = setup.signal().isCancelled() ? RunStop.ABORTED : RunStop.STEP_FAILED;
                detail = String.valueOf(failure.getMessage());
            } finally {
                host.permissionFloor(null);
                if (!host.chatModel().equals(chatBefore)) {
                    host.switchChat(chatBefore);
                }
            }
            emitPlan();
            return end(stop, result, detail, began);
        } catch (RuntimeException | Error broken) {
            // Card 586: a throw outside the graph's own catch, or an Error from a
            // node. An outcome already reached stays; else the run failed.
            if (stop == null) {
                stop = setup.signal().isCancelled() ? RunStop.ABORTED : RunStop.STEP_FAILED;
                detail = errorOf(broken);
            }
            throw broken;
        } finally {
            // Card 586: the one place run_end goes out, so every run ends once,
            // also one that threw before its start line.
            if (!opened) {
                host.emit(lines.runStart(p.name(), setup.task(), forwardNodes(), host.workspace()));
            }
            host.emit(lines.runEnd(stop, result, detail, System.currentTimeMillis() - began));
        }
    }

    private Outcome end(String stop, String result, String detail, long began) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("run", setup.runId());
        f.put("stopReason", stop);
        f.put("result", result);
        f.put("detail", detail);
        f.put("steps", ran.get());
        f.put("durationMs", System.currentTimeMillis() - began);
        setup.recorder().record("playbook_end", f);
        host.emit(RunEvent.PlaybookProgress.ended(AGENT_ID, setup.runId(), stop, result, detail,
                System.currentTimeMillis()));
        return new Outcome(setup.runId(), stop, result, ran.get(), detail);
    }

    // Node bodies.

    private StateUpdate step(Playbook.Step s, GraphState state) {
        ran.incrementAndGet();
        mark(s.id(), "in_progress");
        CancelSignal stepSignal = new CancelSignal();
        Runnable unhook = setup.signal().onCancel(stepSignal::cancel);
        long t0 = System.currentTimeMillis();
        int entry = lines.enter(s.id());
        String childId = null;
        String output = null;
        boolean opened = false;
        boolean closed = false;
        Throwable thrown = null;
        try {
            AgentFile agent = agentOf(s);
            ModelResolver.Resolved model = resolveOrAsk(s.id(), s.model(), s.privacy());
            recordStepStart(s, model, agent);
            Map<String, String> found = documents(state);
            Map<String, Map<Path, Long>> before = snapshots(s.produces());
            StepPrompt.Prompt prompt = StepPrompt.of(setup.pinned(), s, found, setup.task());
            host.emit(lines.stepStart(s.id(), s.name(), "step", entry, new RunSteps.Start(s.performer(),
                    roleOf(s, agent), model.ref().provider(), model.ref().model(), setup.picks().containsKey(s.id()),
                    prompt.record(), reads(s, found), null, null)));
            opened = true;
            host.permissionFloor("inherit".equals(s.permission()) ? null : s.permission());
            if ("child".equals(s.performer())) {
                LlmProvider provider = provider(model.ref());
                AgentType role = AgentType.fromId(agent != null ? agent.type()
                        : s.role() == null ? "worker" : s.role()).orElse(AgentType.WORKER);
                String task = agent != null ? StepPrompt.forAgent(agent, prompt.model()) : prompt.model();
                SubagentManager.StepResult r = manager.runStep(new SubagentManager.StepChild(role, task,
                        prompt.record(), "playbook:" + s.id(), provider), host::emit, stepSignal);
                childId = r.childId();
                output = r.failed() ? r.outcome() : r.answer();
                stopIfCancelled(s.id());
                if (r.failed()) {
                    throw new RunStopped(RunStop.STEP_FAILED, r.outcome());
                }
            } else {
                switchChatFor(s, model.ref());
                PlaybookHost.ChatTurn turn = host.chatTurn(prompt.record(), prompt.model(), stepSignal);
                output = turn.lastText();
                stopIfCancelled(s.id());
                if ("aborted".equals(turn.stopReason())) {
                    throw new RunStopped(RunStop.ABORTED, s.id() + ": the chat turn was aborted");
                }
                if ("error".equals(turn.stopReason())) {
                    throw new RunStopped(RunStop.STEP_FAILED, s.id() + ": " + turn.lastText());
                }
            }
            host.permissionFloor(null);
            if ("private".equals(s.privacy())) {
                privateRan = true;
            }
            Map<String, String> written = changed(s.produces(), before);
            nod(s);
            recordStepEnd(s, childId, true, null, t0);
            host.emit(lines.stepEnd(s.id(), s.name(), "step", entry, new RunSteps.End(RunSteps.DONE,
                    System.currentTimeMillis() - t0, childId, null, output, written(written, before), null, null,
                    null, null)));
            closed = true;
            mark(s.id(), "completed");
            StateUpdate up = StateUpdate.of("documents", written);
            Playbook.Arrow a = PlaybookWalk.arrowFrom(p, s.id(), null);
            return ends.contains(a.to()) ? up.and("result", resultOf(a.to())) : up;
        } catch (RunStopped stopped) {
            thrown = stopped;
            recordStepEnd(s, childId, false, stopped.getMessage(), t0);
            throw stopped;
        } catch (RuntimeException failure) {
            // A host that throws still leaves a step_end behind; the engine
            // writes node_error and run() names the stop.
            thrown = failure;
            recordStepEnd(s, childId, false, String.valueOf(failure.getMessage()), t0);
            throw failure;
        } catch (Error broken) {
            thrown = broken;
            throw broken;
        } finally {
            try {
                if (!closed) {
                    closeStep(s, entry, opened, new RunSteps.End(statusOf(thrown), System.currentTimeMillis() - t0,
                            childId, null, output, List.of(), null, errorOf(thrown), null, null));
                }
            } finally {
                host.permissionFloor(null);
                unhook.run();
            }
        }
    }

    /**
     * Card 586: the end line of a step that a Stop or a failure cut short.
     * When the step failed before its start line went out, for example because
     * its model did not resolve, the start line goes out first, without a
     * model, so the end never stands alone.
     */
    private void closeStep(Playbook.Step s, int entry, boolean opened, RunSteps.End end) {
        if (!opened) {
            host.emit(lines.stepStart(s.id(), s.name(), "step", entry, new RunSteps.Start(s.performer(),
                    roleOf(s, null), null, null, false, null, List.of(), null, null)));
        }
        host.emit(lines.stepEnd(s.id(), s.name(), "step", entry, end));
    }

    private StateUpdate decide(Playbook.Decision d, GraphState state) {
        ran.incrementAndGet();
        mark(d.id(), "in_progress");
        CancelSignal signal = new CancelSignal();
        Runnable unhook = setup.signal().onCancel(signal::cancel);
        long t0 = System.currentTimeMillis();
        int entry = lines.enter(d.id());
        // Card 586: the round this entry opens; its start and every end name it.
        Integer round = d.maxRounds() == null ? null : loops(state).getOrDefault(d.id(), 0) + 1;
        String childId = null;
        String detail = null;
        boolean opened = false;
        boolean closed = false;
        Throwable thrown = null;
        try {
            host.emit(lines.stepStart(d.id(), d.name(), "decision", entry, new RunSteps.Start(null, null, null, null,
                    false, null, List.of(), round, d.maxRounds())));
            opened = true;
            Playbook.Check check = p.checks().get(d.check());
            CheckResult r = check(d, check, documents(state), signal);
            childId = r.childId();
            detail = r.detail();
            stopIfCancelled(d.id());
            String label = r.label();
            if (label == null) {
                String reason = switch (check.kind()) {
                    case "human" -> RunStop.UNANSWERED;
                    case "review" -> r.detail() != null && r.detail().startsWith("ERROR:")
                            ? RunStop.STEP_FAILED : RunStop.REVIEW_UNLABELLED;
                    default -> RunStop.STEP_FAILED;
                };
                recordCheck(d, check, null, loops(state).getOrDefault(d.id(), 0), r.detail(), t0);
                host.emit(lines.stepEnd(d.id(), d.name(), "decision", entry, new RunSteps.End(RunSteps.FAILED,
                        System.currentTimeMillis() - t0, r.childId(), null, r.detail(), List.of(), null, r.detail(),
                        round, d.maxRounds())));
                closed = true;
                throw new RunStopped(reason, d.id() + ": " + r.detail());
            }
            // A round of the decision's own loop counts; a forward exit leaves the
            // count at zero for the next time the run reaches the decision.
            int count = loops(state).getOrDefault(d.id(), 0);
            int next = 0;
            Playbook.Arrow arrow = PlaybookWalk.arrowFrom(p, d.id(), label);
            if (d.maxRounds() != null && arrow != null && PlaybookWalk.isRound(p, d.id(), arrow.to())) {
                if (count >= d.maxRounds()) {
                    label = "exhausted";
                    arrow = PlaybookWalk.arrowFrom(p, d.id(), label);
                } else {
                    count++;
                }
                next = count;
            }
            recordCheck(d, check, label, count, r.detail(), t0);
            host.emit(lines.stepEnd(d.id(), d.name(), "decision", entry, new RunSteps.End(RunSteps.DONE,
                    System.currentTimeMillis() - t0, r.childId(), null, r.detail(), List.of(), label, null,
                    round, d.maxRounds())));
            closed = true;
            mark(d.id(), "completed");
            StateUpdate up = StateUpdate.of("outcome", label).and("loops", Map.of(d.id(), next));
            return arrow != null && ends.contains(arrow.to()) ? up.and("result", resultOf(arrow.to())) : up;
        } catch (RuntimeException | Error failure) {
            thrown = failure;
            throw failure;
        } finally {
            try {
                // A check without a label closes its entry itself before it throws.
                if (opened && !closed) {
                    host.emit(lines.stepEnd(d.id(), d.name(), "decision", entry, new RunSteps.End(statusOf(thrown),
                            System.currentTimeMillis() - t0, childId, null, detail, List.of(), null, errorOf(thrown),
                            round, d.maxRounds())));
                }
            } finally {
                unhook.run();
            }
        }
    }

    private CheckResult check(Playbook.Decision d, Playbook.Check c, Map<String, String> found, CancelSignal signal) {
        List<String> labels = CheckText.labels(c);
        return switch (c.kind()) {
            case "sections" -> CheckResult.all(c.documents().stream().map(id -> DocumentChecks.sections(id,
                    locate(id, found), p.documents().get(id).sections(), c.forbid())).toList());
            case "open_items" -> CheckResult.all(c.documents().stream()
                    .map(id -> DocumentChecks.openItems(id, locate(id, found))).toList());
            case "command" -> CommandCheck.run(CommandCheck.substitute(c.run(), p.vars()), host.workspace(),
                    host.broker(), hostRefusal, host::emit, signal, callId());
            case "review" -> {
                ModelResolver.Resolved model = resolveOrAsk(d.id(), c.model(), ReviewCheck.privacy(p, c.reads()));
                Map<String, Path> docs = new LinkedHashMap<>();
                c.reads().forEach(id -> docs.put(id, locate(id, found)));
                yield ReviewCheck.run(ReviewCheck.task(c.ask(), labels, docs), labels, provider(model.ref()),
                        manager, host::emit, signal, "playbook:" + d.id());
            }
            case "human" -> {
                HumanCheck.Asked a = HumanCheck.ask(callId(), withTask(c.ask()), labels, host.asker(), host::emit);
                yield new CheckResult(a.label(), a.answer() == null ? "no answer" : "answered " + a.answer());
            }
            default -> CheckResult.fail("unknown check kind " + c.kind());
        };
    }

    // Models, privacy, nods.

    private ModelResolver.Resolved resolveOrAsk(String nodeId, String choice, String privacy) {
        while (true) {
            ModelResolver.Resolution r = ModelResolver.resolve(ModelPicks.choiceOf(p, nodeId, choice, setup.picks()),
                    privacy, host::probe);
            if (r instanceof ModelResolver.Resolved ok) {
                return ok;
            }
            ModelResolver.Unavailable u = (ModelResolver.Unavailable) r;
            HumanCheck.Asked a = HumanCheck.ask(callId(),
                    withTask(nodeId + ": " + u.sentence() + ". Retry or stop?"),
                    List.of("retry", "stop"), host.asker(), host::emit);
            if (!"retry".equals(a.label())) {
                throw new RunStopped(RunStop.MODEL_UNAVAILABLE, nodeId + ": " + u.sentence());
            }
        }
    }

    private LlmProvider provider(Playbook.ModelRef ref) {
        try {
            return host.providerFor(ref);
        } catch (IllegalStateException refused) {
            throw new RunStopped(RunStop.MODEL_UNAVAILABLE, ref.provider() + " " + ref.model() + ": " + refused.getMessage());
        }
    }

    private void switchChatFor(Playbook.Step s, Playbook.ModelRef ref) {
        if (host.chatModel().equals(ref)) {
            return;
        }
        if (privateRan && "cloud".equals(host.kindOf(ref.provider())) && cloudConfirmed.add(ref.provider())) {
            HumanCheck.Asked a = HumanCheck.ask(callId(), withTask("The next step sends this chat's history to "
                    + ref.provider() + " " + ref.model() + ". A private step ran earlier in this run. Continue?"),
                    List.of("continue", "stop"), host.asker(), host::emit);
            Map<String, Object> f = new LinkedHashMap<>();
            f.put("run", setup.runId());
            f.put("node", s.id());
            f.put("provider", ref.provider());
            f.put("answer", a.label());
            setup.recorder().record("privacy", f);
            if (!"continue".equals(a.label())) {
                throw new RunStopped(RunStop.PRIVACY_DECLINED, s.id() + ": the switch to " + ref.provider() + " was declined");
            }
        }
        String refused = host.switchChat(ref);
        if (refused != null) {
            throw new RunStopped(RunStop.CHAT_SWITCH_REFUSED, s.id() + ": " + refused);
        }
    }

    private void nod(Playbook.Step s) {
        if (!s.nod()) {
            return;
        }
        HumanCheck.Asked a = HumanCheck.ask(callId(), withTask("Approve the handover of " + s.name() + "?"),
                List.of("approve", "stop"), host.asker(), host::emit);
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("run", setup.runId());
        f.put("node", s.id());
        f.put("answer", a.label());
        f.put("waitMs", a.waitMs());
        setup.recorder().record("nod", f);
        if (!"approve".equals(a.label())) {
            throw new RunStopped(RunStop.NOD_REFUSED, s.id() + ": the handover was not approved");
        }
    }

    /**
     * Card 554, criterion 8g, and the integrator's decision of 2026-10-12:
     * every question a run asks a person names the task the owner typed.
     *
     * @param question the question as the run words it
     * @return the question, with the task below it when the run has one
     */
    private String withTask(String question) {
        return setup.task() == null ? question : question + "\n\nTask: " + setup.task();
    }

    private void stopIfCancelled(String nodeId) {
        if (setup.signal().isCancelled()) {
            throw new RunStopped(RunStop.ABORTED, "stopped during " + nodeId);
        }
    }

    // Documents.

    private Map<String, Map<Path, Long>> snapshots(List<String> ids) {
        Map<String, Map<Path, Long>> out = new LinkedHashMap<>();
        for (String id : ids) {
            out.put(id, snapshot(id));
        }
        return out;
    }

    private Map<Path, Long> snapshot(String id) {
        try {
            return DocumentLocator.snapshot(host.workspace(),
                    DocumentLocator.glob(p.documents().get(id).location(), p.vars()));
        } catch (IOException unreadable) {
            return Map.of();
        }
    }

    private Map<String, String> changed(List<String> ids, Map<String, Map<Path, Long>> before) {
        Map<String, String> out = new LinkedHashMap<>();
        for (String id : ids) {
            Path f = DocumentLocator.changed(before.get(id), snapshot(id));
            if (f != null) {
                out.put(id, host.workspace().relativize(f).toString());
            }
        }
        return out;
    }

    private Path locate(String id, Map<String, String> found) {
        String rel = found.get(id);
        return rel != null ? host.workspace().resolve(rel) : DocumentLocator.newest(snapshot(id));
    }

    // State, plan, sidecar.

    @SuppressWarnings("unchecked")
    private static Object merge(Object current, Object update) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (current instanceof Map<?, ?> m) {
            out.putAll((Map<String, Object>) m);
        }
        if (update instanceof Map<?, ?> m) {
            out.putAll((Map<String, Object>) m);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, String> documents(GraphState state) {
        Object v = state.get("documents");
        return v == null ? Map.of() : (Map<String, String>) v;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Integer> loops(GraphState state) {
        Object v = state.get("loops");
        return v == null ? Map.of() : (Map<String, Integer>) v;
    }

    private String target(String to) {
        return ends.contains(to) ? StateGraph.END : to;
    }

    private String resultOf(String endId) {
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.End e && e.id().equals(endId)) {
                return e.result();
            }
        }
        return endId;
    }

    private String callId() {
        return "pb-" + setup.runId() + "-" + calls.incrementAndGet();
    }

    private void mark(String id, String s) {
        if (status.containsKey(id)) {
            status.put(id, s);
            emitPlan();
        }
    }

    private void emitPlan() {
        List<RunEvent.PlanStep> steps = new ArrayList<>();
        for (Map.Entry<String, String> e : status.entrySet()) {
            steps.add(new RunEvent.PlanStep("[" + e.getKey() + "] " + nameOf(e.getKey()), e.getValue()));
        }
        host.emit(new RunEvent.Plan(AGENT_ID, steps, System.currentTimeMillis()));
    }

    private String nameOf(String id) {
        for (Playbook.Node n : p.nodes()) {
            if (n.id().equals(id)) {
                if (n instanceof Playbook.Step s) {
                    return s.name();
                }
                if (n instanceof Playbook.Decision d) {
                    return d.name();
                }
            }
        }
        return id;
    }

    /**
     * @param s a step
     * @return the pinned agent file of an {@code agent:<name>} child step, null for a static role
     */
    private AgentFile agentOf(Playbook.Step s) {
        if (!"child".equals(s.performer()) || s.role() == null || !s.role().startsWith(PinnedPlaybook.AGENT_ROLE)) {
            return null;
        }
        String name = s.role().substring(PinnedPlaybook.AGENT_ROLE.length());
        AgentFile agent = setup.pinned().agents().get(name);
        if (agent == null) {
            // refusals() stops such a run before any node; a step never falls back to a bare worker.
            throw new RunStopped(RunStop.REFUSED, s.id() + ": agent " + name + " did not resolve");
        }
        return agent;
    }

    private void recordStepStart(Playbook.Step s, ModelResolver.Resolved model, AgentFile agent) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("run", setup.runId());
        f.put("node", s.id());
        f.put("performer", s.performer());
        if (agent != null) {
            f.put("agent", agent.name());
        }
        f.put("choice", s.model());
        if (setup.picks().containsKey(s.id())) {
            f.put("picked", true);
        }
        f.put("provider", model.ref().provider());
        f.put("model", model.ref().model());
        f.put("endpoint", model.probe().endpoint());
        Map<String, Object> probe = new LinkedHashMap<>();
        probe.put("state", model.probe().state());
        probe.put("reason", model.probe().reason());
        probe.put("checkedAt", model.probe().checkedAt());
        f.put("probe", probe);
        f.put("walked", model.walked().stream().map(r -> r.provider() + "/" + r.model()).toList());
        f.put("permission", Permissions.effective(setup.sessionMode(), s.permission()));
        setup.recorder().record("step_start", f);
        host.emit(RunEvent.PlaybookProgress.step(AGENT_ID, setup.runId(), s.id(), s.name(),
                model.ref().provider(), model.ref().model(), System.currentTimeMillis()));
    }

    private void recordStepEnd(Playbook.Step s, String childId, boolean ok, String error, long t0) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("run", setup.runId());
        f.put("node", s.id());
        f.put("child", childId);
        f.put("ok", ok);
        f.put("durationMs", System.currentTimeMillis() - t0);
        f.put("error", error);
        setup.recorder().record("step_end", f);
    }

    private void recordCheck(Playbook.Decision d, Playbook.Check c, String label, int count, String detail, long t0) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("run", setup.runId());
        f.put("node", d.id());
        f.put("check", d.check());
        f.put("kind", c.kind());
        f.put("label", label);
        f.put("loops", count);
        f.put("detail", detail);
        f.put("durationMs", System.currentTimeMillis() - t0);
        setup.recorder().record("check", f);
    }

    // Run view (card 586).

    /** Card 586: the forward path as the run view lists it. */
    private List<RunEvent.RunNode> forwardNodes() {
        List<RunEvent.RunNode> out = new ArrayList<>();
        for (String id : status.keySet()) {
            out.add(new RunEvent.RunNode(id, nameOf(id), kindOf(id)));
        }
        return out;
    }

    private String kindOf(String id) {
        for (Playbook.Node n : p.nodes()) {
            if (n.id().equals(id)) {
                return n instanceof Playbook.Decision ? "decision" : "step";
            }
        }
        return "step";
    }

    /**
     * Card 586: who works on a child step; null for a chat step. An agent
     * role names the agent, also when its file was not read yet.
     */
    private static String roleOf(Playbook.Step s, AgentFile agent) {
        if (!"child".equals(s.performer())) {
            return null;
        }
        if (agent != null) {
            return agent.name();
        }
        String role = s.role() == null ? "worker" : s.role();
        return role.startsWith(PinnedPlaybook.AGENT_ROLE) ? role.substring(PinnedPlaybook.AGENT_ROLE.length()) : role;
    }

    /**
     * Card 586: every document a step is told to read, at the location its
     * prompt names: where this run wrote it, else the document's location.
     * The path is set only when that location is a file inside the workspace.
     */
    private List<RunEvent.RunDoc> reads(Playbook.Step s, Map<String, String> found) {
        List<RunEvent.RunDoc> out = new ArrayList<>();
        for (String id : s.consumes()) {
            String location = found.getOrDefault(id, p.documents().get(id).location());
            out.add(new RunEvent.RunDoc(id, fileInWorkspace(location), null));
        }
        return out;
    }

    /**
     * Card 586: the path is resolved before it is checked, so a symlink
     * anywhere on it, a folder included, cannot lead a line out of the
     * workspace.
     *
     * @return the path of a regular file whose real path lies inside the
     *         workspace's real path, relative to the latter; else null
     */
    private String fileInWorkspace(String location) {
        try {
            Path ws = host.workspace().toRealPath();
            Path file = host.workspace().resolve(location).toRealPath();
            return file.startsWith(ws) && Files.isRegularFile(file) ? ws.relativize(file).toString() : null;
        } catch (IOException | InvalidPathException notThere) {
            return null;
        }
    }

    /** Card 586: the written documents, created when the path was not there before the step. */
    private List<RunEvent.RunDoc> written(Map<String, String> written, Map<String, Map<Path, Long>> before) {
        List<RunEvent.RunDoc> out = new ArrayList<>();
        written.forEach((id, path) -> {
            boolean existed = before.getOrDefault(id, Map.of()).keySet().stream()
                    .anyMatch(k -> host.workspace().relativize(k).toString().equals(path));
            out.add(new RunEvent.RunDoc(id, path, existed ? "changed" : "created"));
        });
        return out;
    }

    /** Card 586: stopped when the owner pressed Stop or the run was aborted, else failed. */
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
