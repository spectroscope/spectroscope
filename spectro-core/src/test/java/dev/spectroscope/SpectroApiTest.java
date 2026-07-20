package dev.spectroscope;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The frozen facade contract — the five lines from the product home's
 * konzept/SPECTRO-API.md compile and run EXACTLY as written. Deviating from
 * that surface needs an owner decision, not a refactor. Loop semantics stay
 * {@code AgentTest}'s business; this class only pins the front door.
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class SpectroApiTest {

    /** One scripted provider turn: a text delta, then a clean end of turn. */
    private static LlmProvider scripted(String text) {
        return request -> List.of(
                new LlmProvider.PTextDelta(text),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    @Test
    void theFiveLinesCompileAndBuildHeadless() throws Exception {
        // the frozen snippet's builder half, verbatim — no key, no network:
        // AnthropicProvider only stores its fields at construction time.
        var agent = Spectro.agent()
                .model(Anthropic.opus())
                .tools(Tools.readFile(), Tools.runCommand())
                .workspace(Path.of("/tmp/scratch"));
        assertNotNull(agent);
    }

    @Test
    void blockingIterationYieldsTheTypedStream() throws Exception {
        Path scratch = Files.createTempDirectory("spectro-api");
        var agent = Spectro.agent()
                .model(scripted("Hello from the stream"))
                .tools(Tools.readFile(), Tools.runCommand())
                .workspace(scratch);

        List<RunEvent> events = new ArrayList<>();
        for (RunEvent event : agent.run("say hello")) {
            events.add(event);
        }

        assertInstanceOf(RunEvent.RunStart.class, events.get(0),
                "the stream opens with run_start");
        assertNotNull(((RunEvent.RunStart) events.get(0)).provider(),
                "run_start names its provider — the stream is the observability");
        assertTrue(events.stream().anyMatch(e -> e instanceof RunEvent.TextDelta t
                        && t.text().contains("Hello from the stream")),
                "the scripted text arrives as text_delta");
        assertInstanceOf(RunEvent.RunEnd.class, events.get(events.size() - 1),
                "the stream terminates with run_end — the for-loop ends by itself");
    }

    @Test
    void printingAnEventIsMeaningful() throws Exception {
        Path scratch = Files.createTempDirectory("spectro-api");
        var agent = Spectro.agent()
                .model(scripted("readable"))
                .workspace(scratch);

        for (RunEvent event : agent.run("go")) {
            String line = event.toString();
            assertFalse(line.isBlank(), "toString carries content");
            assertTrue(line.matches(".*[A-Za-z]+.*\\[.*"),
                    "record-style rendering names the event type: " + line);
        }
    }

    @Test
    void secondRunContinuesTheSameConversation() throws Exception {
        List<LlmProvider.ProviderRequest> requests = new ArrayList<>();
        LlmProvider recording = request -> {
            requests.add(request);
            return List.of(new LlmProvider.PTextDelta("ok"),
                    new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
        };
        var agent = Spectro.agent()
                .model(recording)
                .workspace(Files.createTempDirectory("spectro-api"));

        for (RunEvent ignored : agent.run("first")) { /* drain */ }
        for (RunEvent ignored : agent.run("second")) { /* drain */ }

        assertTrue(requests.get(requests.size() - 1).messages().size() > 1,
                "the second run carries the first exchange as history");
    }

    @Test
    void liveFiveLinesRunExactlyAsFrozen() throws Exception {
        assumeTrue(System.getenv("ANTHROPIC_API_KEY") != null
                        && !System.getenv("ANTHROPIC_API_KEY").isBlank(),
                "live contract check needs ANTHROPIC_API_KEY");

        var agent = Spectro.agent()
                .model(Anthropic.opus())
                .tools(Tools.readFile(), Tools.runCommand())
                .workspace(Path.of("/tmp/scratch"));

        boolean sawEvent = false;
        for (RunEvent event : agent.run("Write hello.py and run it")) {
            System.out.println(event);   // the stream IS the observability
            sawEvent = true;
        }
        assertTrue(sawEvent);
    }
}
