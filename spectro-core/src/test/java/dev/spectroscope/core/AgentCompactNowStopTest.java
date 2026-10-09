package dev.spectroscope.core;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 471, review round: the web chat's {@code /compact} can be stopped.
 *
 * <p>The stop button cancels the signal the compaction was handed. A summary
 * that was cut off by the stop is half a summary, and folding the history into
 * it would lose what the other half held. So a stopped compaction changes
 * nothing, even when the backend still delivered text after the stop.</p>
 */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AgentCompactNowStopTest {

    /**
     * Summarizes with "PARTIAL", stops the signal (the operator presses stop),
     * then keeps streaming; every other request answers "noted".
     */
    private static final class StoppedSummarizer implements LlmProvider {
        final List<ProviderRequest> requests = new ArrayList<>();
        boolean stopMidSummary = true;

        @Override
        public String modelName() {
            return "fake-model-1";
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            if (isSummary(request) && stopMidSummary) {
                List<ProviderEvent> events = new ArrayList<>();
                events.add(new PTextDelta("PARTIAL summary"));
                return () -> new java.util.Iterator<>() {
                    private int at;

                    @Override
                    public boolean hasNext() {
                        return at < 3;
                    }

                    @Override
                    public ProviderEvent next() {
                        at++;
                        if (at == 1) {
                            return events.getFirst();
                        }
                        if (at == 2) {
                            request.signal().cancel();
                            return new PTextDelta(" and more after the stop");
                        }
                        return new PStop(PStop.StopReason.END_TURN);
                    }
                };
            }
            return List.of(new PTextDelta("noted"), new PUsage(1, 1),
                    new PStop(PStop.StopReason.END_TURN));
        }
    }

    /** The summarizer's request is the one with the note-taker's system prompt. */
    static boolean isSummary(LlmProvider.ProviderRequest request) {
        return request.system().startsWith("You are a precise note-taker");
    }

    private static Agent agentOn(LlmProvider provider) {
        return new Agent(AgentOptions.builder()
                .provider(provider)
                .systemPrompt("SYSTEM-471")
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .onPermission(request -> true)
                .build());
    }

    private static void run(Agent agent, String prompt) {
        try (EventStream stream = agent.run(prompt, new RunOptions(null, null))) {
            stream.forEach(event -> { });
        }
    }

    private static Agent withFourRuns(StoppedSummarizer provider) {
        Agent agent = agentOn(provider);
        for (String prompt : List.of("ONE", "TWO", "THREE", "FOUR")) {
            run(agent, prompt);
        }
        return agent;
    }

    private static int messagesOfLastRequest(StoppedSummarizer provider) {
        return provider.requests.getLast().messages().size();
    }

    @Test
    void premiseANotStoppedCompactionFoldsTheHistory() {
        StoppedSummarizer provider = new StoppedSummarizer();
        provider.stopMidSummary = false;
        Agent agent = withFourRuns(provider);

        Optional<RunEvent> result = agent.compactNow(new CancelSignal());
        run(agent, "AFTER");

        assertTrue(result.orElseThrow() instanceof RunEvent.Compaction, String.valueOf(result));
        assertTrue(messagesOfLastRequest(provider) < 9,
                "folded: " + messagesOfLastRequest(provider) + " messages");
    }

    @Test
    void aStoppedCompactionLeavesTheHistoryAsItWas() {
        StoppedSummarizer provider = new StoppedSummarizer();
        Agent agent = withFourRuns(provider);
        CancelSignal stop = new CancelSignal();

        Optional<RunEvent> result = agent.compactNow(stop);
        run(agent, "AFTER");

        assertTrue(stop.isCancelled(), "premise: the stop landed mid-summary");
        assertTrue(result.isEmpty(), "a stopped compaction has no event to record: " + result);
        assertEquals(9, messagesOfLastRequest(provider),
                "four runs of two messages each plus the new prompt, nothing folded");
    }

    @Test
    void theSummarizerIsHandedTheSignalTheCallerGave() {
        StoppedSummarizer provider = new StoppedSummarizer();
        Agent agent = withFourRuns(provider);
        CancelSignal stop = new CancelSignal();

        agent.compactNow(stop);

        LlmProvider.ProviderRequest summary = provider.requests.stream()
                .filter(AgentCompactNowStopTest::isSummary)
                .reduce((first, second) -> second)
                .orElseThrow();
        assertTrue(summary.signal() == stop, "the stop button must reach the summary call");
    }
}
