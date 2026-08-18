package dev.spectroscope.cli;

import dev.spectroscope.core.PlanVerdict;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.permission.Allowlist;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.function.Supplier;

/**
 * The CLI's presentation layer: turns the RunEvent stream into ANSI terminal
 * output. Extracted from SpectroCli (clean-code night job) — the REPL owns the
 * loop and the session, this class owns HOW events look: the main agent's
 * turns render full-width, every child agent renders as indented, dimmed
 * {@code [agent-id]} lines, and permission requests print their prompt (the
 * decision itself stays with the broker in the REPL).
 *
 * <p>The allowlist arrives as a {@link Supplier} because {@code /clear}
 * rebuilds the session and swaps the SpectroCli field; the renderer must always
 * consult the live one.</p>
 */
final class EventRenderer {

    /** Preview widths: one terminal line stays one line. */
    private static final int TOOL_INPUT_PREVIEW_CHARS = 100;
    private static final int TOOL_OUTPUT_PREVIEW_CHARS = 120;
    private static final int CHILD_TASK_PREVIEW_CHARS = 100;
    private static final int AGENT_MESSAGE_PREVIEW_CHARS = 100;
    /** Token counts read as "1.2k" from here up. */
    private static final long KILO_TOKEN_THRESHOLD = 1_000L;

    private final Ansi ansi;
    private final Spinner spinner;
    private final String mainAgentId;
    private final Supplier<Allowlist> allowlist;

    private long runInputTokens;
    private long runOutputTokens;
    // True once a "· thinking" label has been printed this turn; reset each turn so
    // the dim reasoning stream is introduced exactly once, distinct from the answer.
    private boolean thinkingLabelShown;
    private long totalInputTokens;
    private long totalOutputTokens;

    /**
     * The plan ledger of the main agent, latest-wins (card 264).
     *
     * <p>The terminal is the face where {@code update_plan} really is on the
     * belt ({@code SpectroCli:466}), so it is also the face where a run that
     * abandoned its plan can be named. Null until the model writes one — and
     * then the run-end line says {@code no plan on record} rather than letting
     * {@code end_turn} imply a finish nobody measured.</p>
     */
    private RunEvent.Plan lastPlan;

    private final Map<String, String> childRunAgents = new HashMap<>();
    private final Map<String, StringBuilder> childLineBuffers = new HashMap<>();
    /** Auto-approved decisions already printed their own line at request time. */
    private final Map<String, Boolean> autoDecided = new HashMap<>();

    /**
     * @param ansi        the terminal styling (degrades to plain text off-TTY)
     * @param spinner     the thinking animation — stopped before ANY printing so
     *                    frames never interleave with real output
     * @param mainAgentId the agent whose events render full-width; everything else
     *                    takes the indented child view
     * @param allowlist   supplier of the LIVE allowlist — /clear swaps the underlying
     *                    field, and the renderer must always consult the current one
     */
    EventRenderer(Ansi ansi, Spinner spinner, String mainAgentId, Supplier<Allowlist> allowlist) {
        this.ansi = ansi;
        this.spinner = spinner;
        this.mainAgentId = mainAgentId;
        this.allowlist = allowlist;
    }

    /**
     * One entry point: child events take the indented child view.
     *
     * @param event the next event off the run's stream, in arrival order
     */
    void render(RunEvent event) {
        if (isChildEvent(event)) {
            renderChildEvent(event);
        } else {
            renderParentEvent(event);
        }
    }

    /**
     * "X in / Y out" over the whole session — the /cost slash command's line.
     *
     * @return the formatted session totals, kilo-abbreviated from 1000 tokens up
     */
    String sessionUsage() {
        return tokens(totalInputTokens) + " in / " + tokens(totalOutputTokens) + " out";
    }

    // ------------------------------------------------------------ parent view

    /**
     * The main agent's full-width view: streaming text and dimmed thinking, tool
     * cards, permission prompts, compaction/plan/image notices, and the run-end
     * token summary. Usage events only accumulate — they print nothing themselves.
     *
     * @param event a main-agent event (child events never reach this method)
     */
    private void renderParentEvent(RunEvent event) {
        switch (event) {
            case RunEvent.RunStart start -> {
                runInputTokens = 0;
                runOutputTokens = 0;
            }
            case RunEvent.TurnStart turn -> {
                thinkingLabelShown = false;
                spinner.start("forging…");
            }
            case RunEvent.ThinkingDelta thinkingDelta -> {
                spinner.stop();
                if (!thinkingLabelShown) {
                    System.out.print("\n" + ansi.dim("· thinking  "));
                    thinkingLabelShown = true;
                }
                // Dim the whole reasoning stream so it reads clearly apart from the answer.
                System.out.print(ansi.dim(thinkingDelta.text()));
                System.out.flush();
            }
            case RunEvent.TextDelta delta -> {
                spinner.stop();
                // A newline separates a dim reasoning block from the answer that follows.
                if (thinkingLabelShown) {
                    System.out.print("\n");
                    thinkingLabelShown = false;
                }
                System.out.print(delta.text());
                System.out.flush();
            }
            case RunEvent.ToolCall call -> {
                spinner.stop();
                System.out.println("\n" + ansi.coral("⚒ ") + ansi.bold(call.name())
                        + " " + ansi.dim(compact(String.valueOf(call.input()), TOOL_INPUT_PREVIEW_CHARS)));
            }
            case RunEvent.PermissionRequest request -> {
                spinner.stop();
                if (allowlist.get().allows(request)) {
                    // The broker approves silently; tell the human why nothing asked.
                    autoDecided.put(request.callId(), true);
                    System.out.println(ansi.dim("  ✓ auto-approved by allowlist"));
                } else {
                    System.out.print(ansi.sand("  run " + request.name() + "? [y/N] "));
                    System.out.flush();
                }
            }
            case RunEvent.PermissionDecision decision -> {
                if (!allowlistDecided(decision)) {
                    System.out.println(decision.allowed()
                            ? "  " + ansi.green("✓ allowed")
                            : "  " + ansi.red("✗ denied"));
                }
            }
            case RunEvent.ToolResult result -> {
                String mark = result.isError() ? ansi.red("✗") : ansi.green("✓");
                System.out.println("  " + mark + ansi.dim(" " + result.durationMs() + " ms · "
                        + compact(result.output(), TOOL_OUTPUT_PREVIEW_CHARS)));
            }
            case RunEvent.Compaction compaction -> {
                spinner.stop();
                System.out.println("\n" + ansi.sand("◇ compaction: "
                        + compaction.removedTurns() + " messages replaced, summary "
                        + compaction.summaryChars() + " chars"));
            }
            case RunEvent.ImageGenerated image -> {
                spinner.stop();
                System.out.println("\n" + ansi.sand("▣ image · " + image.provider()
                        + " (" + image.model() + ") · ~/.spectro/" + image.blobPath()));
            }
            // Card 252: the CLI is a face too, and the withholding is only honest
            // where it is visible — silence here would be a model answering about
            // a screenshot the terminal shows it never got.
            case RunEvent.ImagesWithheld withheld -> {
                spinner.stop();
                System.out.println("\n" + ansi.sand("▣ " + withheld.images()
                        + (withheld.images() == 1 ? " image" : " images")
                        + " not sent — this model cannot see"
                        + (withheld.model() == null ? "" : " (" + withheld.model() + ")")));
            }
            case RunEvent.Usage usage -> {
                runInputTokens += usage.inputTokens();
                runOutputTokens += usage.outputTokens();
                totalInputTokens += usage.inputTokens();
                totalOutputTokens += usage.outputTokens();
            }
            case RunEvent.RunEnd end -> {
                spinner.stop();
                System.out.println("\n" + ansi.dim("◆ " + end.stopReason() + verdictDetail(end.stopReason())
                        + " · run " + tokens(runInputTokens) + " in / " + tokens(runOutputTokens) + " out"
                        + " · session " + tokens(totalInputTokens) + " in / " + tokens(totalOutputTokens) + " out"));
            }
            case RunEvent.ErrorEvent error -> {
                spinner.stop();
                System.out.println("\n" + ansi.red("✗ error: " + error.message()));
            }
            // Card 195. A block already reached this terminal inside the tool
            // result's ERROR string, without naming which hook produced it. A
            // TIMEOUT reached it as nothing at all, and that is the case worth a
            // line: the call went ahead with a guard that never answered.
            case RunEvent.HookDecision hook -> {
                spinner.stop();
                String head = "⛨ " + hook.event() + " " + hook.verdict()
                        + " · " + compact(hook.command(), TOOL_INPUT_PREVIEW_CHARS);
                System.out.println("  " + ("blocked".equals(hook.verdict())
                        ? ansi.red(head + (hook.reason() == null ? ""
                                : " · " + compact(hook.reason(), TOOL_OUTPUT_PREVIEW_CHARS)))
                        : ansi.sand(head + " after " + hook.timeoutSeconds() + "s — the call ran anyway")));
            }
            // Card 265: the run is asking. Printed HERE and not by the asker, the
            // same split as the gate above — one writer, so the terminal can
            // never show a different question from the one that was asked.
            case RunEvent.QuestionAsked ask -> {
                spinner.stop();
                for (RunEvent.AskedQuestion asked : ask.questions()) {
                    System.out.println("\n" + ansi.sand("? " + (asked.header() == null
                            ? asked.question() : asked.header() + " · " + asked.question())));
                    int number = 1;
                    for (RunEvent.QuestionOption option : asked.options()) {
                        System.out.println("  " + ansi.bold("[" + number++ + "] ") + option.label()
                                + (option.description() == null ? ""
                                        : ansi.dim("  " + option.description())));
                    }
                }
                System.out.print(ansi.sand("  your answer (a number, your own words,"
                        + " or enter to skip) "));
                System.out.flush();
            }
            case RunEvent.QuestionAnswered answered -> {
                // The wait is stated out loud, because it is the number nobody
                // else draws: how long the machine stood waiting for you.
                String waited = answered.waitMs() == null ? ""
                        : " · waited " + (answered.waitMs() / 1000) + "s";
                System.out.println(answered.cancelled()
                        ? "  " + ansi.dim("· unanswered" + waited)
                        : "  " + ansi.green("✓ ") + String.join(", ", answered.answers())
                                + ansi.dim(waited));
            }
            case RunEvent.Plan plan -> {
                spinner.stop();
                lastPlan = plan; // latest-wins, the same ledger the loop and the reducer keep
                System.out.println("\n" + ansi.sand("◇ plan (" + plan.steps().size() + " steps)"));
                for (RunEvent.PlanStep step : plan.steps()) {
                    String mark = switch (step.status()) {
                        case "completed" -> ansi.green("[x]");
                        case "in_progress" -> ansi.coral("[~]");
                        default -> ansi.dim("[ ]");
                    };
                    System.out.println("  " + mark + " " + step.text());
                }
            }
            // Card 262: the guard saw the run stop moving. Printed HERE and not
            // by the guard, the same split as the gate and the question above —
            // one writer, so the terminal can never say something other than
            // what went on the wire. Coral, because unlike a compaction or a
            // plan this is the line a reader is meant to stop at.
            case RunEvent.NoProgress stalled -> {
                spinner.stop();
                System.out.println("\n" + ansi.coral("◈ no progress · " + stalled.detector()
                        + " ×" + stalled.count()) + " " + stalled.evidence());
            }
            default -> { }
        }
    }

    /**
     * What the run-end line appends about the plan (card 264, fix pass) — the
     * same sentence half the HTML export appends, from {@link PlanVerdict}.
     *
     * <p>Two cases earn a word, and they are exactly the two the stop reason
     * cannot carry: {@code unfinished} says a plan was abandoned but not how
     * much of it, and {@code end_turn} with no ledger at all is the ungradable
     * run that used to look like a clean finish. Everything else stays silent —
     * a finished plan agrees with {@code end_turn}, and a brake, a cap or a
     * failure is the more urgent fact on its own.</p>
     *
     * <p>When the wire and this copy of the ledger disagree — a plan left over
     * from before {@code /clear}, or a run graded against a ledger this renderer
     * never saw — the WIRE wins and the line says nothing. The loop graded the
     * run with the ledger it had; a second opinion printed next to the verdict
     * would be the app contradicting itself.</p>
     *
     * @param stopReason the reason the record carries
     * @return the detail, prefixed with the separator, or an empty string
     */
    private String verdictDetail(String stopReason) {
        PlanVerdict verdict = PlanVerdict.of(lastPlan);
        if (PlanVerdict.UNFINISHED_STOP_REASON.equals(stopReason)) {
            return verdict == PlanVerdict.UNFINISHED ? " · " + PlanVerdict.detail(lastPlan) : "";
        }
        if (!"end_turn".equals(stopReason)) {
            return "";
        }
        return verdict == PlanVerdict.UNKNOWN ? " · " + PlanVerdict.detail(null) : "";
    }

    /** Drops the ledger when the REPL starts a fresh session ({@code /clear}
     *  rebuilds the agent, and with it the loop's own copy). */
    void forgetPlan() {
        lastPlan = null;
    }

    /**
     * Whether this decision was already announced as "auto-approved by allowlist"
     * at request time — if so, the ✓/✗ line is suppressed (and the marker consumed).
     *
     * @param decision the decision event closing a permission request
     * @return true when the matching request printed its own auto-approval line
     */
    private boolean allowlistDecided(RunEvent.PermissionDecision decision) {
        return Boolean.TRUE.equals(autoDecided.remove(decision.callId()));
    }

    // ------------------------------------------------------------- child view

    /**
     * Routes an event to the child view — and, as a side effect, tracks which run
     * ids belong to children (a child's {@code run_start} carries a parentId, its
     * {@code run_end} only the run id). A2A messages always count as child traffic.
     *
     * @param event the event to classify
     * @return true when the indented child view must render it
     */
    private boolean isChildEvent(RunEvent event) {
        if (event instanceof RunEvent.RunStart start) {
            if (start.parentId() == null) {
                return false;
            }
            childRunAgents.put(start.runId(), start.agentId());
            return true;
        }
        if (event instanceof RunEvent.RunEnd end) {
            return childRunAgents.containsKey(end.runId());
        }
        // A2A messages are always about a child (task goes main->child, status/
        // result come child->main), so render them all in the child view — else
        // the task line (from=main) would fall through and be dropped.
        if (event instanceof RunEvent.AgentMessage) {
            return true;
        }
        String agentId = agentIdOf(event);
        return agentId != null && !mainAgentId.equals(agentId);
    }

    /**
     * The agent an event belongs to, per event type — the exhaustive switch keeps
     * this in sync with the sealed hierarchy (a new event type fails compilation here).
     *
     * @param event the event to attribute
     * @return the owning agent id; null for decision/run-end events, which carry none
     */
    private static String agentIdOf(RunEvent event) {
        return switch (event) {
            case RunEvent.RunStart e -> e.agentId();
            case RunEvent.TurnStart e -> e.agentId();
            case RunEvent.TextDelta e -> e.agentId();
            case RunEvent.ThinkingDelta e -> e.agentId();
            case RunEvent.ToolCall e -> e.agentId();
            case RunEvent.PermissionRequest e -> e.agentId();
            case RunEvent.ToolResult e -> e.agentId();
            case RunEvent.AgentSpawn e -> e.agentId();
            case RunEvent.Compaction e -> e.agentId();
            case RunEvent.VoiceInput e -> e.agentId();
            case RunEvent.ContextInfo e -> e.agentId();
            case RunEvent.Usage e -> e.agentId();
            case RunEvent.ErrorEvent e -> e.agentId();
            case RunEvent.ImageGenerated e -> e.agentId();
            case RunEvent.AgentMessage e -> e.from(); // the emitting side owns the message
            case RunEvent.Plan e -> e.agentId();
            case RunEvent.LlmExchange e -> e.agentId();
            case RunEvent.BrowserAction e -> e.agentId();
            case RunEvent.HookDecision e -> e.agentId();
            case RunEvent.ImagesWithheld e -> e.agentId();
            case RunEvent.QuestionAsked e -> e.agentId();
            // Card 262: the guard watches one agent's loop; its observation is
            // attributed to that agent so a child's stall reads as the child's.
            case RunEvent.NoProgress e -> e.agentId();
            case RunEvent.PermissionDecision e -> null;
            // Card 265: the answer joins its question by callId and carries no
            // agent, exactly like the verdict that closes a permission request.
            case RunEvent.QuestionAnswered e -> null;
            case RunEvent.RunEnd e -> null;
        };
    }

    /**
     * The child view's line format: indented, coral {@code [agent-id]} tag, dimmed text.
     *
     * @param agentId the child agent the line belongs to
     * @param line    the already-composed content after the tag
     */
    private void printChildLine(String agentId, String line) {
        spinner.stop();
        System.out.println("  " + ansi.coral("[" + agentId + "]") + " " + ansi.dim(line));
    }

    /**
     * The indented child view: lifecycle lines (started/done), per-child line-buffered
     * text (children print whole lines, not token deltas), tool arrows, permission
     * prompts and the A2A task/status/result protocol — each one dim tagged line.
     *
     * @param event an event {@link #isChildEvent} routed here
     */
    private void renderChildEvent(RunEvent event) {
        switch (event) {
            case RunEvent.AgentSpawn spawn ->
                    printChildLine(spawn.agentId(), "started: " + compact(spawn.task(), CHILD_TASK_PREVIEW_CHARS));
            case RunEvent.TextDelta delta -> {
                StringBuilder buffer =
                        childLineBuffers.computeIfAbsent(delta.agentId(), id -> new StringBuilder());
                buffer.append(delta.text());
                int newlineIndex;
                while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
                    String line = buffer.substring(0, newlineIndex);
                    buffer.delete(0, newlineIndex + 1);
                    if (!line.isBlank()) {
                        printChildLine(delta.agentId(), line);
                    }
                }
            }
            case RunEvent.ToolCall call ->
                    printChildLine(call.agentId(), "→ " + call.name() + " "
                            + compact(String.valueOf(call.input()), TOOL_OUTPUT_PREVIEW_CHARS));
            case RunEvent.ToolResult result ->
                    printChildLine(result.agentId(), "← " + (result.isError() ? "ERROR" : "ok")
                            + " (" + result.durationMs() + " ms)");
            case RunEvent.PermissionRequest request -> {
                spinner.stop();
                if (allowlist.get().allows(request)) {
                    autoDecided.put(request.callId(), true);
                    printChildLine(request.agentId(), "✓ auto-approved by allowlist: " + request.name());
                } else {
                    System.out.print("  " + ansi.coral("[" + request.agentId() + "]") + " "
                            + ansi.sand("run " + request.name() + "? [y/N] "));
                    System.out.flush();
                }
            }
            case RunEvent.ErrorEvent error -> {
                if (error.agentId() != null) {
                    printChildLine(error.agentId(), "ERROR: " + error.message());
                }
            }
            // A2A-lite: the visible protocol between the agents, one dim line each.
            case RunEvent.AgentMessage message -> {
                String line = switch (message.role()) {
                    case "task" -> "task" + (message.label() != null ? " (" + message.label() + ")" : "")
                            + ": " + compact(message.text(), AGENT_MESSAGE_PREVIEW_CHARS);
                    case "status" -> "status: " + compact(message.text(), AGENT_MESSAGE_PREVIEW_CHARS);
                    default -> message.state() + ": " + compact(message.text(), AGENT_MESSAGE_PREVIEW_CHARS);
                };
                printChildLine("task".equals(message.role()) ? message.to() : message.from(), line);
            }
            case RunEvent.RunEnd end -> {
                String agentId = childRunAgents.remove(end.runId());
                if (agentId != null) {
                    StringBuilder buffer = childLineBuffers.remove(agentId);
                    if (buffer != null && !buffer.toString().isBlank()) {
                        printChildLine(agentId, buffer.toString().strip());
                    }
                    printChildLine(agentId, "done (" + end.stopReason() + ")");
                }
            }
            default -> { }
        }
    }

    // ------------------------------------------------------------- formatting

    /**
     * Squeezes whitespace runs to single spaces and cuts at the preview budget —
     * one terminal line stays one line.
     *
     * @param text the raw content (tool input, output, task text)
     * @param max  the character budget before the ellipsis cut
     * @return the single-line preview
     */
    private static String compact(String text, int max) {
        String squeezed = text.replaceAll("\\s+", " ").trim();
        return squeezed.length() <= max ? squeezed : squeezed.substring(0, max) + " …";
    }

    /**
     * Token counts as compact labels — plain below 1000, "1.2k" style above.
     *
     * @param count the token count to format
     * @return the display string
     */
    private static String tokens(long count) {
        return count >= KILO_TOKEN_THRESHOLD
                ? String.format(Locale.ROOT, "%.1fk", count / (double) KILO_TOKEN_THRESHOLD)
                : String.valueOf(count);
    }
}
