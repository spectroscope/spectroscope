package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 427, criterion 5, from the headless side.
 *
 * <p>Card 427 lets a question park in {@code auto} and {@code readonly} on the
 * browser face. {@code spectro run --permissions auto|readonly}, a cron fire
 * and a fleet node use the same two words for their broker policy, and none of
 * them has a person to answer. What keeps them out of this change is that the
 * tool is not on their belt. This reads the belt off what the model is actually
 * sent, for both policies, on the runner every headless face builds.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class HeadlessAskFenceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SpectroConfig CONFIG = new SpectroConfig(
            "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
            List.of(), "gemini", true, List.of(), 2, true,
            List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
            null, false, false);

    @Test
    void aHeadlessRunNeverOffersTheModelTheAskUnderEitherPolicy(@TempDir Path cwd) {
        for (boolean autoApprove : new boolean[] {true, false}) {
            String policy = autoApprove ? "auto" : "readonly";
            List<List<String>> advertised = new CopyOnWriteArrayList<>();
            LlmProvider capturing = request -> {
                advertised.add(request.tools().stream().map(LlmProvider.ToolSpec::name).toList());
                return List.of(new LlmProvider.PTextDelta("done"),
                        new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
            };
            HeadlessRunner runner = new HeadlessRunner(JSON, CONFIG, capturing);
            runner.runOnce("check the logs", cwd, autoApprove, null, null, line -> { });

            assertFalse(advertised.isEmpty(), policy + ": the premise, the model was called");
            assertTrue(advertised.getFirst().contains("run_command"),
                    policy + ": the capture saw the real belt: " + advertised.getFirst());
            for (List<String> tools : advertised) {
                assertFalse(tools.contains("ask_user_question"),
                        policy + ": a headless run has nobody to answer, so the model"
                                + " must not be offered the ask: " + tools);
            }
        }
    }
}
