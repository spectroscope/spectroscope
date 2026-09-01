package dev.spectroscope.core.hooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.HookConfig;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.graph.Redaction;
import dev.spectroscope.core.tools.ShellCommand;
import dev.spectroscope.core.tools.ToolOutput;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Runs external {@code pre_tool_use}/{@code post_tool_use} shell hooks around a
 * tool call (Claude-Code style). Container-free (plain {@code new}); constructed
 * from {@code SpectroConfig.hooks()} and injected into {@link dev.spectroscope.core.AgentOptions}.
 *
 * <p>A {@code pre_tool_use} hook BLOCKS the call when it exits non-zero OR prints
 * JSON {@code {"decision":"block","reason":...}} — the call short-circuits before
 * the permission gate and never executes. A {@code post_tool_use} hook is advisory:
 * it runs after execute, its exit code is ignored, and it never rewrites the result.
 * A timed-out hook is fail-open (the permission gate still runs) so a broken hook
 * cannot wedge every tool call.</p>
 */
public final class HookRunner {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The shared tool-output clamp, read from {@link ToolOutput} rather than
     *  kept as a second copy of the same number. */
    @Governs(kind = Governs.Kind.ALIAS, unit = Governs.Unit.CHARACTERS)
    private static final int MAX_OUTPUT_CHARS = ToolOutput.MAX_OUTPUT_CHARS;

    /** The per-hook timeout applied when an entry sets none. Public because the
     *  settings surface prints it ("unset falls back to N seconds") and a second
     *  spelling of N is a number that drifts. */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.SECONDS, key = "hooks[].timeoutSeconds")
    public static final long DEFAULT_TIMEOUT_SECONDS = 10;

    /** How the reason of a redacted command reads, so the marker is one string.
     *  Mirrors the sidecar's own {@code [redacted: rule]} shape. */
    private static final String REDACTED = "[redacted: %s]";

    /**
     * What one hook DID on one tool call — the two outcomes worth a line.
     *
     * <p>A pass is deliberately absent. A verdict per passing hook per tool call
     * would bury the two that matter, and "nothing objected" is what the tool
     * result already says.</p>
     */
    public enum Verdict {

        /** The hook vetoed the call: it never executed and never met the gate. */
        BLOCKED("blocked"),

        /** The deadline killed the hook. The call proceeds (fail-open), which is
         *  precisely why this is recorded: a guard that never answered must not
         *  read as a guard that agreed. */
        TIMED_OUT("timed-out");

        private final String wireName;

        Verdict(String wireName) {
            this.wireName = wireName;
        }

        /** The spelling used on the wire and on screen.
         *  @return the verdict's wire name */
        public String wireName() {
            return wireName;
        }
    }

    /**
     * One hook's part in one tool call, as the run records it.
     *
     * <p>{@code command} is REDACTED by {@link Redaction}'s rules before it lands
     * here. It is operator-written config, it travels into the session file, and
     * a session file is the artefact people export and paste — a hook that curls
     * a webhook with a bearer token would otherwise put that token into every
     * session it ever fired in.</p>
     *
     * @param event          the phase this hook is configured for
     * @param matcher        the tool-name glob it matched with, defaulted
     * @param command        the shell string, redacted whole when a credential shape fires
     * @param timeoutSeconds the budget this hook actually ran under, defaults resolved
     * @param verdict        what it did
     * @param reason         the hook's stated reason on a block; null on a timeout
     */
    public record HookRun(String event, String matcher, String command, long timeoutSeconds,
                          Verdict verdict, String reason) {}

    /** The verdict of a {@code pre_tool_use} evaluation.
     *
     *  <p><b>A block must carry the run that blocked.</b> The whole point of
     *  this record's {@code runs} list is that a refusal names its refuser: the
     *  agent emits one {@code hook_decision} per entry here, so a blocking
     *  outcome with no blocking run is a call refused by nobody, which is the
     *  invisibility this card removed. It used to be reachable — a
     *  {@code block(reason)} factory built exactly that shape and documented the
     *  trap in its own {@code @return} line — so the compact constructor refuses
     *  it instead of leaving it to discipline.</p>
     *
     *  @param blocked true when a hook vetoed the call — it never executes
     *  @param reason  the hook's stated reason; null on a pass
     *  @param runs    every hook of this evaluation that blocked or timed out, in
     *                 the order they ran; empty when every hook simply agreed */
    public record HookOutcome(boolean blocked, String reason, List<HookRun> runs) {
        /** Defensive copy — the list travels into an event stream — plus the one
         *  invariant this record exists to hold.
         *  @param blocked true when a hook vetoed the call
         *  @param reason  the hook's stated reason; null on a pass
         *  @param runs    the notable hook runs
         *  @throws IllegalArgumentException when a block carries no blocking run */
        public HookOutcome {
            runs = List.copyOf(runs);
            if (blocked && runs.stream().noneMatch(run -> run.verdict() == Verdict.BLOCKED)) {
                throw new IllegalArgumentException(
                        "a blocked call must carry the hook run that blocked it — otherwise the "
                                + "refusal emits no hook_decision and nothing in the run says who "
                                + "refused it or why.");
            }
        }
    }

    /**
     * Injectable process seam so tests script an exit code without a real shell
     * (the bonus-2 Transcriber CommandRunner precedent). {@code timedOut} lets the
     * runner report a killed-on-timeout process without a magic exit code.
     */
    @FunctionalInterface
    public interface CommandRunner {
        /** Runs one hook command to completion or timeout.
         *  @param command        the shell string from the hook config
         *  @param env            extra process environment — the SPECTRO_TOOL_* variables
         *  @param cwd            working directory for the hook process
         *  @param timeoutSeconds kill-after budget for the process
         *  @param signal         cooperative cancel forwarded from the run
         *  @return exit code, captured stdout, and whether the deadline killed it */
        Result run(String command, Map<String, String> env, Path cwd,
                   long timeoutSeconds, CancelSignal signal);

        /** What a hook process came back with.
         *  @param exitCode process exit status — non-zero blocks in the pre phase
         *  @param stdout   the captured output, cap applied
         *  @param timedOut true when the process was killed on the deadline */
        record Result(int exitCode, String stdout, boolean timedOut) {}
    }

    private final List<HookConfig> hooks;
    private final CommandRunner runner;
    private final long defaultTimeoutSeconds;

    /**
     * Full wiring — tests inject a scripted runner and their own default timeout.
     *
     * @param hooks                 the configured hook entries, defensively copied
     * @param runner                the process seam that actually executes commands
     * @param defaultTimeoutSeconds per-hook timeout applied when an entry sets none
     */
    public HookRunner(List<HookConfig> hooks, CommandRunner runner, long defaultTimeoutSeconds) {
        this.hooks = List.copyOf(hooks);
        this.runner = runner;
        this.defaultTimeoutSeconds = defaultTimeoutSeconds;
    }

    /** The production runner over the configured hooks, backed by {@code /bin/sh}.
     *  @param hooks the {@code hooks} block from the settings hierarchy
     *  @return a runner executing real shell commands with the default timeout */
    public static HookRunner load(List<HookConfig> hooks) {
        return new HookRunner(hooks, HookRunner::runShell, DEFAULT_TIMEOUT_SECONDS);
    }

    /** Evaluates every matching pre_tool_use hook; the first block wins.
     *
     *  <p>A timed-out hook is still walked past (fail-open, unchanged), but it is
     *  now RECORDED as it is walked past: a guard that never answered used to be
     *  indistinguishable from a guard that agreed, in the tool result and
     *  everywhere downstream of it.</p>
     *
     *  @param toolName the tool about to run, matched against each hook's glob
     *  @param input    the model-supplied arguments, exported as SPECTRO_TOOL_INPUT
     *  @param cwd      working directory for the hook processes
     *  @param signal   cooperative cancel forwarded to each process
     *  @return the first blocking verdict, or a pass when every hook agrees —
     *          carrying every notable hook run either way */
    public HookOutcome preToolUse(String toolName, JsonNode input, Path cwd, CancelSignal signal) {
        List<HookRun> runs = new ArrayList<>();
        for (HookConfig hook : hooks) {
            if (!appliesTo(hook, "pre_tool_use", toolName)) {
                continue;
            }
            long timeout = hook.timeoutOrDefault(defaultTimeoutSeconds);
            CommandRunner.Result result = runner.run(hook.command(),
                    env(toolName, input, null), cwd, timeout, signal);
            if (result.timedOut()) {
                // fail-open: a broken hook must not wedge every tool call. The
                // walk goes on; the fact that part of the fence was down does not
                // get dropped on the way.
                runs.add(record(hook, timeout, Verdict.TIMED_OUT, null));
                continue;
            }
            String reason = null;
            if (result.exitCode() != 0) {
                reason = "exit " + result.exitCode()
                        + (result.stdout().isBlank() ? "" : ": " + result.stdout().strip());
            } else {
                reason = blockReason(result.stdout());
            }
            if (reason != null) {
                runs.add(record(hook, timeout, Verdict.BLOCKED, reason));
                return new HookOutcome(true, reason, runs);
            }
        }
        return new HookOutcome(false, null, runs);
    }

    /** Advisory: runs every matching post_tool_use hook and ignores the exit code.
     *
     *  <p>Which is why only a timeout comes back: a non-zero exit here is not a
     *  finding by design, and reporting one would invent a veto this phase does
     *  not have.</p>
     *
     *  @param toolName   the tool that just ran, matched against each hook's glob
     *  @param input      the model-supplied arguments, exported as SPECTRO_TOOL_INPUT
     *  @param toolResult the tool's output, exported as SPECTRO_TOOL_RESULT
     *  @param cwd        working directory for the hook processes
     *  @param signal     cooperative cancel forwarded to each process
     *  @return the hooks whose deadline killed them, in the order they ran */
    public List<HookRun> postToolUse(String toolName, JsonNode input, String toolResult,
                                     Path cwd, CancelSignal signal) {
        List<HookRun> runs = new ArrayList<>();
        for (HookConfig hook : hooks) {
            if (!appliesTo(hook, "post_tool_use", toolName)) {
                continue;
            }
            long timeout = hook.timeoutOrDefault(defaultTimeoutSeconds);
            CommandRunner.Result result = runner.run(hook.command(),
                    env(toolName, input, toolResult), cwd, timeout, signal);
            if (result.timedOut()) {
                runs.add(record(hook, timeout, Verdict.TIMED_OUT, null));
            }
        }
        return List.copyOf(runs);
    }

    /** One notable hook run, with the command run past {@link Redaction} first.
     *  @param hook    the entry that fired
     *  @param timeout the budget it actually ran under
     *  @param verdict what it did
     *  @param reason  its stated reason, or null
     *  @return the record for the event stream */
    private static HookRun record(HookConfig hook, long timeout, Verdict verdict, String reason) {
        return new HookRun(hook.event(), hook.matcherOrDefault(), safe(hook.command()),
                timeout, verdict, reason);
    }

    /** The command as it may be recorded: whole, or replaced whole when a
     *  credential shape fires in it. Partial masking would leave the tail of a
     *  key, which is still a key — {@link Redaction}'s own rule.
     *  @param command the configured shell string
     *  @return the command, or a marker naming the rule that fired */
    private static String safe(String command) {
        String rule = Redaction.firstRule(command);
        return rule == null ? command : REDACTED.formatted(rule);
    }

    /** One predicate for both phases: right event, matching tool-name glob.
     *  @param hook     the configured entry under test
     *  @param event    the phase being dispatched (pre_tool_use / post_tool_use)
     *  @param toolName the tool the hook would fire for
     *  @return true when the hook participates in this call */
    private static boolean appliesTo(HookConfig hook, String event, String toolName) {
        return event.equals(hook.event()) && matches(hook.matcherOrDefault(), toolName);
    }

    /** stdout that parses as {@code {"decision":"block","reason":...}} → the reason.
     *  @param stdout the hook's captured output; may be null, empty or non-JSON
     *  @return the block reason (defaulted when blank), or null when it is no block verdict */
    private static String blockReason(String stdout) {
        String trimmed = stdout == null ? "" : stdout.strip();
        if (trimmed.isEmpty() || trimmed.charAt(0) != '{') {
            return null;
        }
        try {
            JsonNode node = JSON.readTree(trimmed);
            if ("block".equals(node.path("decision").asText())) {
                String reason = node.path("reason").asText("");
                return reason.isBlank() ? "denied by hook" : reason;
            }
        } catch (IOException notJson) {
            return null; // non-JSON stdout with exit 0 is a pass
        }
        return null;
    }

    /** Glob on the tool name: {@code "*"}, an exact name, or a {@code prefix*} rule.
     *  @param matcher  the configured glob
     *  @param toolName the candidate tool name
     *  @return true on a match */
    private static boolean matches(String matcher, String toolName) {
        if ("*".equals(matcher) || matcher.equals(toolName)) {
            return true;
        }
        if (matcher.endsWith("*")) {
            return toolName.startsWith(matcher.substring(0, matcher.length() - 1));
        }
        return false;
    }

    /** Assembles the process environment a hook script reads — its whole input contract.
     *  @param toolName   exported as SPECTRO_TOOL_NAME
     *  @param input      exported as SPECTRO_TOOL_INPUT (empty string when null)
     *  @param toolResult exported as SPECTRO_TOOL_RESULT; omitted entirely in the pre phase (null)
     *  @return the extra environment entries for the hook process */
    private static Map<String, String> env(String toolName, JsonNode input, String toolResult) {
        Map<String, String> env = new HashMap<>();
        env.put("SPECTRO_TOOL_NAME", toolName);
        env.put("SPECTRO_TOOL_INPUT", input == null ? "" : input.toString());
        if (toolResult != null) {
            env.put("SPECTRO_TOOL_RESULT", toolResult);
        }
        return env;
    }

    /** The default runner — the same {@link ShellCommand} behind run_command, so a
     *  hook printing more than the pipe buffer still exits and its verdict counts
     *  (a drain-less runner would fail-open exactly on large-output guards).
     *  @param command        the shell string from the hook config
     *  @param env            the SPECTRO_TOOL_* variables for the process
     *  @param cwd            working directory for the process
     *  @param timeoutSeconds kill-after budget
     *  @param signal         cooperative cancel forwarded to the process
     *  @return the mapped result; a launch failure becomes NO_EXIT plus a message */
    private static CommandRunner.Result runShell(String command, Map<String, String> env,
                                                 Path cwd, long timeoutSeconds, CancelSignal signal) {
        ShellCommand.Result result = ShellCommand.run(command, env, cwd, timeoutSeconds,
                signal, MAX_OUTPUT_CHARS);
        if (result.failure() != null) {
            return new CommandRunner.Result(ShellCommand.NO_EXIT,
                    "hook error: " + result.failure(), false);
        }
        return new CommandRunner.Result(result.exitCode(), result.output(), result.timedOut());
    }
}
