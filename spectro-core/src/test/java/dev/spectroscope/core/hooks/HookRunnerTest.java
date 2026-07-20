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
}
