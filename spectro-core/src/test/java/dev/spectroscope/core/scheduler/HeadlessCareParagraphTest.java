package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.session.CareTexts;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * Card 492 on the unattended face: {@code spectro run}, a cron fire and a
 * fleet node build their agent here. With the key on the request ends with
 * the paragraph, and since this face registers no spawn tool the sentence
 * about subagents is left out. With the key off the request is the one
 * v0.14.4 sent.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class HeadlessCareParagraphTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static SpectroConfig config(String care) {
        SpectroConfig base = new SpectroConfig(
                "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
                List.of(), "gemini", true, List.of(), 2, true,
                List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
                null, false, false);
        return new SpectroConfig(base.provider(), base.model(), base.baseUrl(),
                base.compactionThreshold(), base.permissionMode(), base.autoApprove(),
                base.imageProvider(), base.thinking(), base.mcpServers(), base.maxRetries(),
                base.promptCaching(), base.hooks(), base.workspace(), base.logLevel(),
                base.imageModel(), base.sttModel(), base.sttProvider(), base.sttLanguage(),
                base.chromeBinary(), base.otlpEndpoint(), base.otlpBasicAuth(),
                base.ollamaBaseUrl(), base.lmstudioBaseUrl(), base.searxngUrl(),
                base.allowLocalhost(), base.headlessMcp(), base.progressGuardWrites(),
                base.progressGuardFailures(), base.progressGuardPlanTurns(),
                base.continuationBudget(), base.maxTurns(), base.llamacppBaseUrl(),
                base.questionsPerRun(), base.maxQuestionOptions(), base.maxQuestionChars(),
                base.commandTimeoutSeconds(), base.chatReserveWidth(), base.dockMaxWidth(),
                base.maxTokens(), base.subagentBudgetSeconds(), base.rtkFilter(),
                base.subagentBudgetTokens(), base.desktopNotifications(),
                base.toolResultElision(), base.toolGroupsOff(), care);
    }

    private static List<String> runWith(String care, Path cwd) {
        List<String> systems = new ArrayList<>();
        LlmProvider provider = request -> {
            systems.add(request.system());
            return List.of(new LlmProvider.PTextDelta("done"),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        };
        new HeadlessRunner(JSON, config(care), provider)
                .runOnce("describe the repository", cwd, false, null, null, line -> { });
        assertFalse(systems.isEmpty(), "premise: the provider was asked");
        return systems;
    }

    private static String fixture() throws IOException {
        try (InputStream in = HeadlessCareParagraphTest.class
                .getResourceAsStream("/care-v0144/headless-request-system.txt")) {
            assertNotNull(in, "the v0.14.4 headless capture is missing");
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void withTheKeyOffTheHeadlessRequestIsTheOneVersion0144Sent(@TempDir Path cwd) throws IOException {
        assertEquals(fixture(), runWith("off", cwd).get(0));
    }

    @Test
    void withTheKeyOnTheHeadlessRequestEndsWithTheParagraphWithoutSubagents(@TempDir Path cwd)
            throws IOException {
        assertEquals(fixture() + "\n\n" + CareTexts.NO_SUBAGENTS, runWith("on", cwd).get(0));
    }
}
