package dev.spectroscope.core.hooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.HookConfig;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Hook block semantics, proven with a scripted CommandRunner — no real process needed. */
class HookRunnerTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final JsonNode INPUT = JSON.createObjectNode().put("command", "rm -rf /");
    private static final Path CWD = Path.of(".");

    private static HookConfig pre() {
        return new HookConfig("*", "pre_tool_use", "the-command", null);
    }

    @Test
    void aNonZeroExitPreHookBlocksTheCall() {
        HookRunner runner = new HookRunner(List.of(pre()),
                (cmd, env, cwd, timeout, signal) -> new HookRunner.CommandRunner.Result(2, "nope", false),
                10);
        HookRunner.HookOutcome outcome = runner.preToolUse("run_command", INPUT, CWD, new CancelSignal());
        assertTrue(outcome.blocked());
        assertTrue(outcome.reason().contains("exit 2"), outcome.reason());
    }

    @Test
    void blockingJsonOnStdoutBlocksEvenWithExitZero() {
        HookRunner runner = new HookRunner(List.of(pre()),
                (cmd, env, cwd, timeout, signal) -> new HookRunner.CommandRunner.Result(
                        0, "{\"decision\":\"block\",\"reason\":\"blocked by policy\"}", false),
                10);
        HookRunner.HookOutcome outcome = runner.preToolUse("run_command", INPUT, CWD, new CancelSignal());
        assertTrue(outcome.blocked());
        assertEquals("blocked by policy", outcome.reason());
    }

    @Test
    void aPassingHookIsTransparentAndPassesToolMetadataInTheEnv() {
        AtomicReference<Map<String, String>> seen = new AtomicReference<>();
        HookRunner runner = new HookRunner(List.of(pre()),
                (cmd, env, cwd, timeout, signal) -> {
                    seen.set(env);
                    return new HookRunner.CommandRunner.Result(0, "", false);
                },
                10);
        HookRunner.HookOutcome outcome = runner.preToolUse("run_command", INPUT, CWD, new CancelSignal());
        assertFalse(outcome.blocked());
        assertEquals("run_command", seen.get().get("SPECTRO_TOOL_NAME"));
        assertTrue(seen.get().get("SPECTRO_TOOL_INPUT").contains("rm -rf"));
    }

    @Test
    void aMatcherThatDoesNotMatchTheToolIsSkipped() {
        HookRunner runner = new HookRunner(
                List.of(new HookConfig("write_file", "pre_tool_use", "the-command", null)),
                (cmd, env, cwd, timeout, signal) -> new HookRunner.CommandRunner.Result(2, "", false),
                10);
        assertFalse(runner.preToolUse("run_command", INPUT, CWD, new CancelSignal()).blocked(),
                "a hook scoped to write_file must not fire on run_command");
    }

    @Test
    void aTimedOutHookFailsOpenSoABrokenHookCannotWedgeTheAgent() {
        HookRunner runner = new HookRunner(List.of(pre()),
                (cmd, env, cwd, timeout, signal) -> new HookRunner.CommandRunner.Result(-1, "", true),
                1);
        assertFalse(runner.preToolUse("run_command", INPUT, CWD, new CancelSignal()).blocked());
    }

    @Test
    void postToolUseIsAdvisoryRunsButNeverBlocks() {
        AtomicReference<String> sawResult = new AtomicReference<>();
        HookRunner runner = new HookRunner(
                List.of(new HookConfig("*", "post_tool_use", "the-command", null)),
                (cmd, env, cwd, timeout, signal) -> {
                    sawResult.set(env.get("SPECTRO_TOOL_RESULT"));
                    return new HookRunner.CommandRunner.Result(9, "", false); // non-zero is ignored
                },
                10);
        runner.postToolUse("run_command", INPUT, "the output", CWD, new CancelSignal());
        assertEquals("the output", sawResult.get());
    }

    @Test
    void theDefaultShellRunnerBlocksOnARealNonZeroExit() {
        HookRunner runner = HookRunner.load(
                List.of(new HookConfig("*", "pre_tool_use", "exit 2", null)));
        assertTrue(runner.preToolUse("run_command", INPUT, CWD, new CancelSignal()).blocked());
    }

    @Test
    void aBlockingHookWithHugeOutputStillBlocks() {
        // Regression: the old wait-then-read runner deadlocked on the full pipe
        // buffer, timed out, and the fail-open path BYPASSED the block. The
        // drained runner lets the child exit, so its verdict counts.
        HookRunner runner = HookRunner.load(List.of(new HookConfig("*", "pre_tool_use",
                "head -c 200000 /dev/zero | tr '\\0' x; exit 1", null)));
        assertTrue(runner.preToolUse("run_command", INPUT, CWD, new CancelSignal()).blocked(),
                "a guard must not be bypassed by printing more than the pipe buffer");
    }

    @Test
    void hookEventsAreValidatedLoudly() {
        // A typo would otherwise silently disable the guard forever.
        assertThrows(IllegalArgumentException.class,
                () -> new HookConfig("*", "pre-tool-use", "exit 1", null));
    }

    // ---- card 195: what the runner RECORDS, so a surface has something true ----
    //
    // Before this card the runner answered blocked/not-blocked and nothing else,
    // so nobody downstream could say WHICH hook fired, and a timed-out hook was
    // indistinguishable from a hook that passed. Both are asserted here rather
    // than in the UI, because the UI must render a decision and never make one.

    @Test
    void aBlockNamesTheHookThatMadeIt() {
        HookRunner runner = new HookRunner(
                List.of(new HookConfig("run_*", "pre_tool_use", "deny.sh", 4)),
                (cmd, env, cwd, timeout, signal) -> new HookRunner.CommandRunner.Result(2, "nope", false),
                10);
        HookRunner.HookOutcome outcome = runner.preToolUse("run_command", INPUT, CWD, new CancelSignal());
        assertEquals(1, outcome.runs().size());
        HookRunner.HookRun run = outcome.runs().get(0);
        assertEquals(HookRunner.Verdict.BLOCKED, run.verdict());
        assertEquals("pre_tool_use", run.event());
        assertEquals("run_*", run.matcher());
        assertEquals("deny.sh", run.command());
        assertEquals(4, run.timeoutSeconds(), "the hook's own timeout, not the runner default");
    }

    @Test
    void aTimedOutHookIsRecordedAsTimedOutAndNeverAsPassed() {
        // The fail-open behaviour itself is deliberate and unchanged (see the
        // test above). What changes is that it stops being SILENT: passing over
        // a guard that never answered is a fact the run has to carry.
        HookRunner runner = new HookRunner(List.of(pre()),
                (cmd, env, cwd, timeout, signal) -> new HookRunner.CommandRunner.Result(-1, "", true),
                7);
        HookRunner.HookOutcome outcome = runner.preToolUse("run_command", INPUT, CWD, new CancelSignal());
        assertFalse(outcome.blocked(), "fail-open stands");
        assertEquals(1, outcome.runs().size());
        assertEquals(HookRunner.Verdict.TIMED_OUT, outcome.runs().get(0).verdict());
        assertEquals(7, outcome.runs().get(0).timeoutSeconds(), "the runner default, this hook set none");
    }

    @Test
    void aPassingHookIsRecordedAsNothingAtAll() {
        // A run that emitted a line per passing hook would bury the two lines
        // that matter under one per tool call per hook.
        HookRunner runner = new HookRunner(List.of(pre()),
                (cmd, env, cwd, timeout, signal) -> new HookRunner.CommandRunner.Result(0, "", false),
                10);
        assertTrue(runner.preToolUse("run_command", INPUT, CWD, new CancelSignal()).runs().isEmpty());
    }

    @Test
    void aTimedOutPostHookIsRecordedToo() {
        // post_tool_use ignores the exit code by design, so a non-zero one is
        // not a finding. A hook that never answered is.
        HookRunner runner = new HookRunner(
                List.of(new HookConfig("*", "post_tool_use", "notify.sh", null),
                        new HookConfig("*", "post_tool_use", "slow.sh", null)),
                (cmd, env, cwd, timeout, signal) ->
                        "slow.sh".equals(cmd)
                                ? new HookRunner.CommandRunner.Result(-1, "", true)
                                : new HookRunner.CommandRunner.Result(9, "", false),
                10);
        List<HookRunner.HookRun> runs =
                runner.postToolUse("run_command", INPUT, "out", CWD, new CancelSignal());
        assertEquals(1, runs.size());
        assertEquals("slow.sh", runs.get(0).command());
        assertEquals(HookRunner.Verdict.TIMED_OUT, runs.get(0).verdict());
    }

    @Test
    void aHookThatTimedOutBeforeTheOneThatBlockedIsCarriedTooNotSwallowed() {
        // The first block wins and stops the walk — but a guard that never
        // answered ahead of it still happened, and dropping it would report the
        // call as cleanly refused when part of the fence was down.
        HookRunner runner = new HookRunner(
                List.of(new HookConfig("*", "pre_tool_use", "slow.sh", null),
                        new HookConfig("*", "pre_tool_use", "deny.sh", null)),
                (cmd, env, cwd, timeout, signal) ->
                        "slow.sh".equals(cmd)
                                ? new HookRunner.CommandRunner.Result(-1, "", true)
                                : new HookRunner.CommandRunner.Result(3, "", false),
                10);
        HookRunner.HookOutcome outcome = runner.preToolUse("run_command", INPUT, CWD, new CancelSignal());
        assertTrue(outcome.blocked());
        assertEquals(List.of(HookRunner.Verdict.TIMED_OUT, HookRunner.Verdict.BLOCKED),
                outcome.runs().stream().map(HookRunner.HookRun::verdict).toList());
    }

    @Test
    void theRecordedCommandIsRedactedWhenItCarriesACredentialShape() {
        // The command is operator-written config and it lands in the session
        // file, which is the artefact people export and paste. A hook that
        // curls a webhook with a bearer token would otherwise put that token
        // into every session that hook ever fired in.
        String secret = "curl -H 'Authorization: Bearer " + "ghp_" + "0123456789abcdefghij0123456789abcdef" + "' x";
        HookRunner runner = new HookRunner(
                List.of(new HookConfig("*", "pre_tool_use", secret, null)),
                (cmd, env, cwd, timeout, signal) -> new HookRunner.CommandRunner.Result(2, "", false),
                10);
        HookRunner.HookRun run =
                runner.preToolUse("run_command", INPUT, CWD, new CancelSignal()).runs().get(0);
        assertFalse(run.command().contains("ghp_"), run.command());
        assertTrue(run.command().startsWith("[redacted:"), run.command());
    }

    @Test
    void theRunnerDefaultTimeoutIsReadableRatherThanRespelledElsewhere() {
        // The settings surface prints "unset falls back to N seconds". A second
        // spelling of N is a number that drifts; this is the one.
        assertEquals(10, HookRunner.DEFAULT_TIMEOUT_SECONDS);
    }
}
