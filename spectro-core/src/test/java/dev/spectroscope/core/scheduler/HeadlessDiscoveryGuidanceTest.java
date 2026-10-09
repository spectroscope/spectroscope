package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Agent;
import dev.spectroscope.core.AgentOptions;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.EventStream;
import dev.spectroscope.core.RunOptions;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.subagents.RoleCatalog;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 470 on the unattended face: {@code spectro run}, every cron fire and
 * every fleet node build their agent in {@link HeadlessRunner}, so the
 * discovery paragraph has to be in the request this runner SENDS, not only in
 * a constant.
 *
 * <p>The second half measures what the paragraph costs with the same reader
 * the context ring shows: the {@code system prompt} part of the loop's own
 * {@code context_info} event.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class HeadlessDiscoveryGuidanceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SpectroConfig CONFIG = new SpectroConfig(
            "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
            List.of(), "gemini", true, List.of(), 2, true,
            List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
            null, false, false);

    /** Answers once and records the system prompt of every request it gets. */
    private static LlmProvider answersOnce(List<String> systems) {
        return request -> {
            systems.add(request.system());
            return List.of(new LlmProvider.PTextDelta("done"),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        };
    }

    @Test
    void theHeadlessRequestCarriesTheDiscoveryParagraph(@TempDir Path cwd) {
        List<String> systems = new ArrayList<>();
        HeadlessRunner runner = new HeadlessRunner(JSON, CONFIG, answersOnce(systems));
        runner.runOnce("describe the repository", cwd, false, null, null, line -> { });

        assertTrue(RoleCatalog.DISCOVERY_GUIDANCE.contains("explore child"),
                "the premise: the paragraph is not empty, so 'contains' below is not vacuous");
        assertNotNull(runner.lastAgent(), "the premise: a run happened and built an agent");
        assertTrue(runner.lastAgent().systemPrompt().contains(RoleCatalog.DISCOVERY_GUIDANCE),
                "the headless agent is built with the paragraph: " + runner.lastAgent().systemPrompt());
        assertFalse(systems.isEmpty(), "the premise: the provider was asked at least once");
        assertTrue(systems.get(0).contains(RoleCatalog.DISCOVERY_GUIDANCE),
                "the request the headless face sends carries the paragraph: " + systems.get(0));
    }

    /** The {@code system prompt} part of the first context_info the loop emits. */
    private static int ringSystemChars(String systemPrompt) {
        Agent agent = new Agent(AgentOptions.builder()
                .provider(answersOnce(new ArrayList<>()))
                .systemPrompt(systemPrompt)
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .introspection(true)   // the faces that show the ring switch this on
                .build());
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run("describe the repository",
                new RunOptions(new CancelSignal(), null))) {
            stream.forEach(events::add);
        }
        return events.stream()
                .filter(RunEvent.ContextInfo.class::isInstance)
                .map(RunEvent.ContextInfo.class::cast)
                .findFirst().orElseThrow()
                .parts().stream()
                .filter(part -> part.label().equals("system prompt"))
                .findFirst().orElseThrow()
                .chars();
    }

    @Test
    void theParagraphAddsUnderSixHundredCharsToWhatTheRingReads() {
        String with = HeadlessRunner.HEADLESS_SYSTEM_PROMPT;
        String joined = " " + RoleCatalog.DISCOVERY_GUIDANCE;
        assertTrue(RoleCatalog.DISCOVERY_GUIDANCE.contains("explore child"),
                "the premise: the paragraph is not empty");
        assertTrue(with.contains(joined), "the premise: the headless prompt carries the paragraph");
        String without = with.replace(joined, "");

        int withChars = ringSystemChars(with);
        int withoutChars = ringSystemChars(without);
        int added = withChars - withoutChars;
        System.out.println("card-470 ring system prompt chars: without=" + withoutChars
                + " with=" + withChars + " added=" + added
                + " paragraph=" + RoleCatalog.DISCOVERY_GUIDANCE.length());
        assertTrue(added > 0, "the ring sees the paragraph at all, added=" + added);
        assertTrue(added < 600, "card 470 allows under 600 chars, the ring reads " + added);
    }

    @Test
    void theParagraphAddsUnderSixHundredCharsToTheInteractiveBasePrompt(@TempDir Path workspace) {
        // The browser session and the REPL start from RoleCatalog.BASE_SYSTEM_PROMPT
        // plus the working directory; this reads that assembly with the same ring reader.
        String with = RoleCatalog.BASE_SYSTEM_PROMPT + workspace;
        String joined = " " + RoleCatalog.DISCOVERY_GUIDANCE;
        assertTrue(RoleCatalog.DISCOVERY_GUIDANCE.contains("explore child"),
                "the premise: the paragraph is not empty");
        assertTrue(with.contains(joined), "the premise: the interactive base prompt carries the paragraph");
        String without = with.replace(joined, "");

        int withChars = ringSystemChars(with);
        int withoutChars = ringSystemChars(without);
        int added = withChars - withoutChars;
        System.out.println("card-470 ring interactive system prompt chars: without=" + withoutChars
                + " with=" + withChars + " added=" + added
                + " paragraph=" + RoleCatalog.DISCOVERY_GUIDANCE.length());
        assertTrue(added > 0, "the ring sees the paragraph at all, added=" + added);
        assertTrue(added < 600, "card 470 allows under 600 chars, the ring reads " + added);
    }
}
