package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Card 266's fence, from the side that costs money: <b>an unattended face does
 * not continue by itself.</b>
 *
 * <p>The leash's default is 3 and it ships ON for the two attended faces, so the
 * half of that decision which protects the bill is "off everywhere nobody is
 * watching". The wiring is the fence — the same one card 262's guard and card
 * 265's ask use, and the reason {@code konzept/ORCHESTRATION.md} refusal 5 keeps
 * executing verbs off unattended faces.</p>
 *
 * <p>Until this file existed that half was a comment. Every unattended lane in
 * the product builds its agent in {@link HeadlessRunner} — {@code spectro run}
 * (RunCommand), a cron fire (CronCommand) and a fleet node (NodeCommand,
 * TriggeredNode) all construct one — so a single {@code .continuationLeash(...)}
 * clause added there would have put every 3 a.m. job on a self-extending budget
 * with the whole Java gate staying green. Card 222's finding F4, in the
 * direction where nobody would have noticed.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class HeadlessContinuationFenceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SpectroConfig CONFIG = new SpectroConfig(
            "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
            List.of(), "gemini", true, List.of(), 2, true,
            List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
            null, false, false);

    /** Answers once and stops — enough to make {@code runOnce} assemble an agent. */
    private static LlmProvider answersOnce() {
        return request -> List.of(new LlmProvider.PTextDelta("done"),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    @Test
    void aHeadlessRunBuildsAnAgentWithNoLeashAtAll(@TempDir Path cwd) {
        HeadlessRunner runner = new HeadlessRunner(JSON, CONFIG, answersOnce());
        runner.runOnce("check the logs", cwd, false, null, null, line -> { });

        assertNotNull(runner.lastAgent(), "the premise: a run happened and built an agent");
        assertNull(runner.lastAgent().continuationLeash(),
                "spectro run, every cron fire and every fleet node build their agent here,"
                        + " and none of them has a person watching the bill — the shipped"
                        + " budget of 3 must not reach any of them");
    }

    @Test
    void theShippedBudgetIsNonZeroSoTheFenceAboveIsNotVacuous(@TempDir Path cwd) {
        // Without this, the test above would still pass on a build where the
        // leash was off everywhere and the fence meant nothing.
        org.junit.jupiter.api.Assertions.assertTrue(
                dev.spectroscope.core.loop.ContinuationLeash.DEFAULT_BUDGET > 0,
                "the leash ships ON somewhere, which is what makes 'not here' a fence");
    }
}
