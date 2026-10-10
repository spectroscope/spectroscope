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
     */
    public record Setup(PinnedPlaybook pinned, String runId, Path graphFile, PlaybookRecorder recorder,
                        CancelSignal signal, String sessionMode) {
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
    private boolean privateRan;

    public PlaybookRunner(Setup setup, PlaybookHost host, SubagentManager manager,
                          Function<String, Optional<String>> hostRefusal) {
        this.setup = setup;
        this.p = setup.pinned().playbook();
        this.host = host;
        this.manager = manager;
        this.hostRefusal = hostRefusal;
        this.ends = PlaybookWalk.endIds(p);
        PlaybookWalk.forwardPath(p).forEach(id -> status.put(id, "pending"));
    }

    /** @return 12 lower hex characters, the engine's own run id shape */
    public static String newRunId() {
        return UUID.randomUUID().toString().replace("-", "").substring(0, 12);
    }

    /**
     * @param pinned the pinned playbook
     * @param canAsk whether a person can answer here
     * @param kindOf provider kind by name, without a request
     * @return every reason this playbook may not start; empty when it may
     */
    public static List<String> refusals(PinnedPlaybook pinned, boolean canAsk, Function<String, String> kindOf) {
        Playbook p = pinned.playbook();
        List<String> out = new ArrayList<>();
        pinned.missingSkills().forEach(name -> out.add("skill not found: " + name));
        out.addAll(pinned.missingAgents().values());
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Step s) {
                if ("extended".equals(s.permission())) {
                    out.add(s.id() + ": a playbook may not set permission extended");
                }
                if ("private".equals(s.privacy()) && "cloud".equals(kindOf.apply(p.models().get(s.model()).primary().provider()))) {
                    out.add(s.id() + ": a private step may not run on the cloud provider "
                            + p.models().get(s.model()).primary().provider());
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

    /** @return how the run ended; never throws */
    public Outcome run() {
        long began = System.currentTimeMillis();
        Playbook.ModelRef chatBefore = host.chatModel();
        Map<String, Object> start = new LinkedHashMap<>();
        start.put("run", setup.runId());
        start.put("playbook", p.id());
        start.put("dir", setup.pinned().dir().toString());
        start.put("hash", setup.pinned().hash());
        start.put("mode", setup.sessionMode());
        start.put("chat", Map.of("provider", chatBefore.provider(), "model", chatBefore.model()));
        setup.recorder().record("playbook_start", start);
        List<String> refused = refusals(setup.pinned(), host.asker() != null, host::kindOf);
        if (!refused.isEmpty()) {
            return end(RunStop.REFUSED, null, String.join("; ", refused), began);
        }
        emitPlan();
        String stop = RunStop.DONE;
        String result = null;
        String detail = null;
        try (GraphArtifact artifact = new GraphArtifact(setup.graphFile())) {
            GraphState out = graph().compile(artifact).invoke(GraphState.empty(), RunConfig.defaults());
            result = (String) out.get("result");
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
        return new Outcome(setup.runId(), stop, result, ran.get(), detail);
    }

    // Node bodies.

    private StateUpdate step(Playbook.Step s, GraphState state) {
        ran.incrementAndGet();
        mark(s.id(), "in_progress");
        CancelSignal stepSignal = new CancelSignal();
        Runnable unhook = setup.signal().onCancel(stepSignal::cancel);
        long t0 = System.currentTimeMillis();
        String childId = null;
        try {
            AgentFile agent = agentOf(s);
            ModelResolver.Resolved model = resolveOrAsk(s.id(), s.model(), s.privacy());
            recordStepStart(s, model, agent);
            Map<String, String> found = documents(state);
            Map<String, Map<Path, Long>> before = snapshots(s.produces());
            StepPrompt.Prompt prompt = StepPrompt.of(setup.pinned(), s, found);
            host.permissionFloor("inherit".equals(s.permission()) ? null : s.permission());
            if ("child".equals(s.performer())) {
                LlmProvider provider = provider(model.ref());
                AgentType role = AgentType.fromId(agent != null ? agent.type()
                        : s.role() == null ? "worker" : s.role()).orElse(AgentType.WORKER);
                String task = agent != null ? StepPrompt.forAgent(agent, prompt.model()) : prompt.model();
                SubagentManager.StepResult r = manager.runStep(new SubagentManager.StepChild(role, task,
                        prompt.record(), "playbook:" + s.id(), provider), host::emit, stepSignal);
                childId = r.childId();
                stopIfCancelled(s.id());
                if (r.failed()) {
                    throw new RunStopped(RunStop.STEP_FAILED, r.outcome());
                }
            } else {
                switchChatFor(s, model.ref());
                PlaybookHost.ChatTurn turn = host.chatTurn(prompt.record(), prompt.model(), stepSignal);
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
            mark(s.id(), "completed");
            StateUpdate up = StateUpdate.of("documents", written);
            Playbook.Arrow a = PlaybookWalk.arrowFrom(p, s.id(), null);
            return ends.contains(a.to()) ? up.and("result", resultOf(a.to())) : up;
        } catch (RunStopped stopped) {
            recordStepEnd(s, childId, false, stopped.getMessage(), t0);
            throw stopped;
        } catch (RuntimeException failure) {
            // A host that throws still leaves a step_end behind; the engine
            // writes node_error and run() names the stop.
            recordStepEnd(s, childId, false, String.valueOf(failure.getMessage()), t0);
            throw failure;
        } finally {
            host.permissionFloor(null);
            unhook.run();
        }
    }

    private StateUpdate decide(Playbook.Decision d, GraphState state) {
        ran.incrementAndGet();
        mark(d.id(), "in_progress");
        CancelSignal signal = new CancelSignal();
        Runnable unhook = setup.signal().onCancel(signal::cancel);
        long t0 = System.currentTimeMillis();
        try {
            Playbook.Check check = p.checks().get(d.check());
            CheckResult r = check(d, check, documents(state), signal);
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
                throw new RunStopped(reason, d.id() + ": " + r.detail());
            }
            int count = loops(state).getOrDefault(d.id(), 0);
            Playbook.Arrow arrow = PlaybookWalk.arrowFrom(p, d.id(), label);
            if (d.maxRounds() != null && arrow != null && PlaybookWalk.canReach(p, arrow.to(), d.id())) {
                if (count >= d.maxRounds()) {
                    label = "exhausted";
                    arrow = PlaybookWalk.arrowFrom(p, d.id(), label);
                } else {
                    count++;
                }
            }
            recordCheck(d, check, label, count, r.detail(), t0);
            mark(d.id(), "completed");
            StateUpdate up = StateUpdate.of("outcome", label).and("loops", Map.of(d.id(), count));
            return arrow != null && ends.contains(arrow.to()) ? up.and("result", resultOf(arrow.to())) : up;
        } finally {
            unhook.run();
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
                HumanCheck.Asked a = HumanCheck.ask(callId(), c.ask(), labels, host.asker(), host::emit);
                yield new CheckResult(a.label(), a.answer() == null ? "no answer" : "answered " + a.answer());
            }
            default -> CheckResult.fail("unknown check kind " + c.kind());
        };
    }

    // Models, privacy, nods.

    private ModelResolver.Resolved resolveOrAsk(String nodeId, String choice, String privacy) {
        while (true) {
            ModelResolver.Resolution r = ModelResolver.resolve(p.models().get(choice), privacy, host::probe);
            if (r instanceof ModelResolver.Resolved ok) {
                return ok;
            }
            ModelResolver.Unavailable u = (ModelResolver.Unavailable) r;
            HumanCheck.Asked a = HumanCheck.ask(callId(), nodeId + ": " + u.sentence() + ". Retry or stop?",
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
            HumanCheck.Asked a = HumanCheck.ask(callId(), "The next step sends this chat's history to "
                    + ref.provider() + " " + ref.model() + ". A private step ran earlier in this run. Continue?",
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
        HumanCheck.Asked a = HumanCheck.ask(callId(), "Approve the handover of " + s.name() + "?",
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
}
