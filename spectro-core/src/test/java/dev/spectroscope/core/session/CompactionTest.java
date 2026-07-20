package dev.spectroscope.core.session;

import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Compaction semantics: threshold gate, summary replacement, failure safety. */
class CompactionTest {

    /** A provider whose "summary" is scripted; records whether it was called with tools. */
    private static final class SummaryProvider implements LlmProvider {
        final List<ProviderRequest> requests = new ArrayList<>();
        private final String summary;

        SummaryProvider(String summary) {
            this.summary = summary;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            return List.of(new PTextDelta(summary), new PStop(PStop.StopReason.END_TURN));
        }
    }

    /** user/assistant alternation, `count` messages long. */
    private static List<ProviderMessage> history(int count) {
        return IntStream.range(0, count)
                .mapToObj(i -> new ProviderMessage(
                        i % 2 == 0 ? ProviderMessage.Role.USER : ProviderMessage.Role.ASSISTANT,
                        List.of(new TextContent("message-" + i))))
                .toList();
    }

    @Test
    void belowTheThresholdNothingHappens() {
        SummaryProvider provider = new SummaryProvider("unused");
        Compaction.Result result = Compaction.maybeCompact(
                provider, history(10), 500, 1_000, "main", new CancelSignal());
        assertNull(result.event());
        assertEquals(10, result.messages().size());
        assertTrue(provider.requests.isEmpty(), "no summary call below the threshold");
    }

    @Test
    void aboveTheThresholdOldTurnsBecomeASummary() {
        SummaryProvider provider = new SummaryProvider("The user is building a harness.");
        List<ProviderMessage> messages = history(10);

        Compaction.Result result = Compaction.maybeCompact(
                provider, messages, 5_000, 1_000, "main", new CancelSignal());

        RunEvent.Compaction event = assertInstanceOf(RunEvent.Compaction.class, result.event());
        assertEquals(6, event.removedTurns(), "10 messages minus 4 kept");
        assertTrue(event.summaryChars() > 0);

        // New history: summary + 4 kept messages; the summary (user role) merges
        // with the first kept user message, so 4 messages remain in total.
        assertEquals(4, result.messages().size());
        TextContent first = assertInstanceOf(TextContent.class,
                result.messages().getFirst().content().getFirst());
        assertTrue(first.text().contains("[Summary of the conversation so far]"));
        assertTrue(first.text().contains("The user is building a harness."));
        assertEquals(2, result.messages().getFirst().content().size(),
                "summary and the first kept user message share one merged message");

        // The summary call itself: no tools, ever.
        assertEquals(1, provider.requests.size());
        assertTrue(provider.requests.getFirst().tools().isEmpty());
    }

    @Test
    void theCutNeverStrandsToolResultsFromRemovedCalls() {
        SummaryProvider provider = new SummaryProvider("summary");
        // Position the cut so `recent` would START with a tool_result message.
        List<ProviderMessage> messages = new ArrayList<>(history(6));
        messages.add(new ProviderMessage(ProviderMessage.Role.USER,
                List.of(new ToolResultContent("c9", "output", false))));
        messages.addAll(history(3)); // total 10; keep=4 → recent starts at the tool_result

        Compaction.Result result = Compaction.maybeCompact(
                provider, messages, 5_000, 1_000, "main", new CancelSignal());

        assertInstanceOf(RunEvent.Compaction.class, result.event());
        ProviderMessage afterSummary = result.messages().get(1);
        boolean startsWithToolResult = afterSummary.content().stream()
                .anyMatch(ToolResultContent.class::isInstance);
        assertTrue(!startsWithToolResult,
                "recent must not start with tool_results whose calls were summarized away");
    }

    @Test
    void aFailingSummaryCallLeavesTheHistoryUntouched() {
        LlmProvider failing = request -> {
            throw new IllegalStateException("rate limited");
        };
        List<ProviderMessage> messages = history(10);

        Compaction.Result result = Compaction.maybeCompact(
                failing, messages, 5_000, 1_000, "main", new CancelSignal());

        RunEvent.ErrorEvent error = assertInstanceOf(RunEvent.ErrorEvent.class, result.event());
        assertTrue(error.message().contains("Compaction failed"));
        assertEquals(messages, result.messages(), "on failure the history stays unchanged");
    }

    @Test
    void tinyHistoriesAreNeverCompacted() {
        SummaryProvider provider = new SummaryProvider("unused");
        Compaction.Result result = Compaction.maybeCompact(
                provider, history(5), 5_000, 1_000, "main", new CancelSignal());
        assertNull(result.event(), "5 messages ≤ keep+2 — nothing to win");
        assertTrue(provider.requests.isEmpty());
    }
}
