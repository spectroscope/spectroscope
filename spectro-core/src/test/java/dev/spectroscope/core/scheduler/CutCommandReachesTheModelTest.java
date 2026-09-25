package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 384, end to end: a run whose shell command is cut by
 * {@code commandTimeoutSeconds}. The event stream carries the result as an
 * error, and the model's next request carries what the command printed.
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class CutCommandReachesTheModelTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static SpectroConfig configuredWith(Path dir, String json) throws IOException {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), json);
        return SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
    }

    @Test
    void theModelReadsTheBuildLogOfACutCommandAndTheCardIsAnError(@TempDir Path dir,
            @TempDir Path cwd) throws IOException {
        SpectroConfig config = configuredWith(dir,
                "{ \"maxTurns\": 2, \"commandTimeoutSeconds\": 1 }");
        List<RunEvent.ToolResult> results = new ArrayList<>();
        List<LlmProvider.ToolResultContent> handedToTheModel = new ArrayList<>();
        LlmProvider oneCutBuild = request -> {
            if (request.messages().size() >= 3) {
                request.messages().stream()
                        .flatMap(message -> message.content().stream())
                        .filter(LlmProvider.ToolResultContent.class::isInstance)
                        .map(LlmProvider.ToolResultContent.class::cast)
                        .forEach(handedToTheModel::add);
                return List.of(new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
            }
            return List.of(
                    new LlmProvider.PToolCall("c384", "run_command",
                            JSON.createObjectNode().put("command",
                                    "printf 'module 1 ok\\nmodule 2 ok\\nmodule 3 ok\\n"
                                            + "module 4 ok\\n'; exec sleep 10")),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        };

        new HeadlessRunner(JSON, config, oneCutBuild)
                .runOnce("Build it", cwd, true, null, event -> {
                    if (event instanceof RunEvent.ToolResult result) {
                        results.add(result);
                    }
                }, line -> { });

        assertEquals(1, results.size(), "the shell tool ran once: " + results);
        RunEvent.ToolResult cut = results.get(0);
        assertTrue(cut.isError(), "a cut command reads as a success: " + cut.output());
        assertTrue(cut.output().startsWith("ERROR: command timed out after 1 s."),
                cut.output());
        assertTrue(cut.output().contains("module 4 ok"),
                "the event carries none of what the command printed: " + cut.output());

        assertEquals(1, handedToTheModel.size(), "the model got no tool result back");
        LlmProvider.ToolResultContent read = handedToTheModel.get(0);
        assertTrue(read.isError(), read.output());
        assertTrue(read.output().contains("module 4 ok"),
                "the model reads one error line and none of the build log: " + read.output());
    }
}
