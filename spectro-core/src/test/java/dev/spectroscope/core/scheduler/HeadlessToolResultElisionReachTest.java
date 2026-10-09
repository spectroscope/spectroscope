package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.ProviderRequest;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 467 on the unattended faces: {@code spectro run}, a cron fire and a
 * fleet node build their agent in {@code HeadlessRunner}, and the operator's
 * {@code toolResultElision} has to arrive there, read off the requests a real
 * run sends with the real {@code read_file}.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class HeadlessToolResultElisionReachTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String FILE = "LINE-OF-THE-BIG-FILE\n".repeat(1_500);

    private static SpectroConfig configuredWith(Path dir, String json) throws IOException {
        Files.createDirectories(dir.resolve(".spectro"));
        Files.writeString(dir.resolve(SpectroConfig.PROJECT_SETTINGS), json);
        return SpectroConfig.load(SpectroConfig.Overrides.none(), dir);
    }

    /** Turn 1 reads big.txt, every later turn lists the folder, until the ceiling. */
    private static LlmProvider readThenList(List<ProviderRequest> requests) {
        return request -> {
            requests.add(request);
            String id = "c" + requests.size();
            return List.of(requests.size() == 1
                            ? new LlmProvider.PToolCall(id, "read_file",
                                    JSON.createObjectNode().put("path", "big.txt"))
                            : new LlmProvider.PToolCall(id, "list_dir",
                                    JSON.createObjectNode().put("path", ".")),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.TOOL_USE));
        };
    }

    private static String lastSentRead(List<ProviderRequest> requests) {
        for (ProviderMessage message : requests.getLast().messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof ToolResultContent result && "c1".equals(result.callId())) {
                    return result.output();
                }
            }
        }
        throw new AssertionError("the last request carries no read result");
    }

    private static List<ProviderRequest> run(Path dir, Path cwd, String settings) throws IOException {
        Files.writeString(cwd.resolve("big.txt"), FILE);
        List<ProviderRequest> requests = new CopyOnWriteArrayList<>();
        new HeadlessRunner(JSON, configuredWith(dir, settings), readThenList(requests))
                .runOnce("Read big.txt, then keep looking", cwd, false, null, event -> { },
                        line -> { });
        return requests;
    }

    @Test
    void aSpectroRunStubsAnOldReadByDefault(@TempDir Path dir, @TempDir Path cwd) throws IOException {
        List<ProviderRequest> requests = run(dir, cwd, "{ \"maxTurns\": 9 }");

        assertTrue(requests.get(1).messages().toString().contains("LINE-OF-THE-BIG-FILE"),
                "premise: the real read_file returned the file in turn 2");
        assertFalse(lastSentRead(requests).contains("LINE-OF-THE-BIG-FILE"),
                "an unattended run resent a read eight turns old in full");
    }

    @Test
    void aSpectroRunHonoursTheOperatorsOff(@TempDir Path dir, @TempDir Path cwd) throws IOException {
        List<ProviderRequest> requests =
                run(dir, cwd, "{ \"maxTurns\": 9, \"toolResultElision\": \"off\" }");

        assertTrue(lastSentRead(requests).contains("LINE-OF-THE-BIG-FILE"),
                "the operator turned the elision off and an unattended run stubbed anyway");
    }
}
