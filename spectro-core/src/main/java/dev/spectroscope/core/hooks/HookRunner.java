package dev.spectroscope.core.hooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.HookConfig;
import dev.spectroscope.core.tools.ShellCommand;
import dev.spectroscope.core.tools.ToolOutput;

import java.io.IOException;
import java.nio.file.Path;
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
    private static final int MAX_OUTPUT_CHARS = ToolOutput.MAX_OUTPUT_CHARS;
    private static final long DEFAULT_TIMEOUT_SECONDS = 10;

    /** The verdict of a {@code pre_tool_use} evaluation.
     *  @param blocked true when a hook vetoed the call — it never executes
     *  @param reason  the hook's stated reason; null on a pass */
    public record HookOutcome(boolean blocked, String reason) {
        /** The let-it-run verdict — no hook objected. */
        public static HookOutcome pass() { return new HookOutcome(false, null); }
        /** A veto.
         *  @param reason why the hook blocked — surfaced to the model in the ERROR result */
        public static HookOutcome block(String reason) { return new HookOutcome(true, reason); }
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
     *  @param toolName the tool about to run, matched against each hook's glob
     *  @param input    the model-supplied arguments, exported as SPECTRO_TOOL_INPUT
     *  @param cwd      working directory for the hook processes
     *  @param signal   cooperative cancel forwarded to each process
     *  @return the first blocking verdict, or a pass when every hook agrees */
    public HookOutcome preToolUse(String toolName, JsonNode input, Path cwd, CancelSignal signal) {
        for (HookConfig hook : hooks) {
            if (!appliesTo(hook, "pre_tool_use", toolName)) {
                continue;
            }
            CommandRunner.Result result = runner.run(hook.command(),
                    env(toolName, input, null), cwd,
                    hook.timeoutOrDefault(defaultTimeoutSeconds), signal);
            if (result.timedOut()) {
                continue; // fail-open: a broken hook must not wedge every tool call
            }
            if (result.exitCode() != 0) {
                return HookOutcome.block("exit " + result.exitCode()
                        + (result.stdout().isBlank() ? "" : ": " + result.stdout().strip()));
            }
            String reason = blockReason(result.stdout());
            if (reason != null) {
                return HookOutcome.block(reason);
            }
        }
        return HookOutcome.pass();
    }

    /** Advisory: runs every matching post_tool_use hook and ignores the exit code.
     *  @param toolName   the tool that just ran, matched against each hook's glob
     *  @param input      the model-supplied arguments, exported as SPECTRO_TOOL_INPUT
     *  @param toolResult the tool's output, exported as SPECTRO_TOOL_RESULT
     *  @param cwd        working directory for the hook processes
     *  @param signal     cooperative cancel forwarded to each process */
    public void postToolUse(String toolName, JsonNode input, String toolResult,
                            Path cwd, CancelSignal signal) {
        for (HookConfig hook : hooks) {
            if (!appliesTo(hook, "post_tool_use", toolName)) {
                continue;
            }
            runner.run(hook.command(), env(toolName, input, toolResult), cwd,
                    hook.timeoutOrDefault(defaultTimeoutSeconds), signal);
        }
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
