package dev.spectroscope.core.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider;
import dev.spectroscope.core.provider.LlmProvider.PStop;
import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolCallContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 467, review: with tool-result elision on, compaction triggers on the
 * size of the elided request, so the full history can be far larger than the
 * window by the time it fires. The summarizer reads the full history where it
 * fits the threshold and the stubbed request view where it does not.
 *
 * <p>Sizes here are in the chars/4 estimate the context gauge uses: a result
 * of 40,000 chars is 10,000 tokens.</p>
 */
class CompactionRequestViewTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final String STUB = "[stub]";

    /** Records summarizer requests; fails any request the predicate refuses. */
    private static final class Summarizer implements LlmProvider {
        final List<ProviderRequest> requests = new ArrayList<>();
        private final Predicate<ProviderRequest> refuses;

        Summarizer(Predicate<ProviderRequest> refuses) {
            this.refuses = refuses;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            requests.add(request);
            if (refuses.test(request)) {
                throw new IllegalStateException("context length exceeded");
            }
            return List.of(new PTextDelta("the summary"), new PStop(PStop.StopReason.END_TURN));
        }
    }

    private static String big(String tag) {
        return (tag + "-").repeat(40_000 / (tag.length() + 1) + 1).substring(0, 40_000);
    }

    /**
     * Three reads r1, r2, r3 of 40,000 chars each, then four small messages
     * that compaction keeps. Returns the full history; {@link #view} stubs the
     * three reads the way the request carried them.
     */
    private static List<ProviderMessage> history() {
        List<ProviderMessage> history = new ArrayList<>();
        history.add(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("go"))));
        for (String id : List.of("r1", "r2", "r3")) {
            history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(
                    new ToolCallContent(id, "read_file", JSON.createObjectNode().put("path", id)))));
            history.add(new ProviderMessage(ProviderMessage.Role.USER, List.of(
                    new ToolResultContent(id, big(id.toUpperCase()), false))));
        }
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("a"))));
        history.add(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("b"))));
        history.add(new ProviderMessage(ProviderMessage.Role.ASSISTANT, List.of(new TextContent("c"))));
        history.add(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent("d"))));
        return List.copyOf(history);
    }

    private static List<ProviderMessage> view(List<ProviderMessage> history) {
        List<ProviderMessage> view = new ArrayList<>();
        for (ProviderMessage message : history) {
            List<ProviderContent> content = new ArrayList<>();
            for (ProviderContent piece : message.content()) {
                content.add(piece instanceof ToolResultContent result
                        ? new ToolResultContent(result.callId(), STUB, false) : piece);
            }
            view.add(new ProviderMessage(message.role(), List.copyOf(content)));
        }
        return List.copyOf(view);
    }

    private static String readOf(LlmProvider.ProviderRequest request, String callId) {
        for (ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                if (content instanceof ToolResultContent result && result.callId().equals(callId)) {
                    return result.output();
                }
            }
        }
        throw new AssertionError("the summarizer request carries no result for " + callId);
    }

    private static Compaction.Result compact(Summarizer provider, List<ProviderMessage> history,
                                             int summaryInputTokens) {
        return Compaction.maybeCompact(provider, history, view(history), 50_000, 1_000,
                summaryInputTokens, "main", new CancelSignal(), null, 4_000);
    }

    @Test
    void theSummarizerReadsTheFullHistoryWhenItFits() {
        Summarizer provider = new Summarizer(request -> false);

        Compaction.Result result = compact(provider, history(), 100_000);

        assertInstanceOf(RunEvent.Compaction.class, result.event());
        assertEquals(1, provider.requests.size());
        for (String id : List.of("r1", "r2", "r3")) {
            assertEquals(big(id.toUpperCase()), readOf(provider.requests.getFirst(), id),
                    "a history that fits reached the summarizer stubbed at " + id);
        }
    }

    @Test
    void whenTheFullHistoryDoesNotFitTheNewestResultsStayFullAndTheOldestAreStubbed() {
        Summarizer provider = new Summarizer(request -> false);

        // 25,000 tokens hold two of the three 10,000-token reads, not three.
        Compaction.Result result = compact(provider, history(), 25_000);

        assertInstanceOf(RunEvent.Compaction.class, result.event());
        LlmProvider.ProviderRequest request = provider.requests.getFirst();
        assertEquals(STUB, readOf(request, "r1"), "the oldest read should give way first");
        assertEquals(big("R2"), readOf(request, "r2"));
        assertEquals(big("R3"), readOf(request, "r3"));
        assertTrue(estimatedTokens(request) <= 25_000,
                "the summarizer input is larger than the room it was given: "
                        + estimatedTokens(request));
    }

    @Test
    void whenNothingMoreFitsTheSummarizerReadsTheRequestView() {
        Summarizer provider = new Summarizer(request -> false);

        Compaction.Result result = compact(provider, history(), 1_000);

        assertInstanceOf(RunEvent.Compaction.class, result.event());
        for (String id : List.of("r1", "r2", "r3")) {
            assertEquals(STUB, readOf(provider.requests.getFirst(), id));
        }
    }

    @Test
    void aSummarizerThatRefusesTheFittedHistoryIsAskedAgainWithTheRequestView() {
        // The estimate is chars/4 and a backend can count more tokens than
        // that. A refusal of the fitted history falls back to the view, which
        // is no larger than the request the backend accepted last turn.
        Summarizer provider = new Summarizer(request -> !readOf(request, "r3").equals(STUB));

        Compaction.Result result = compact(provider, history(), 100_000);

        assertInstanceOf(RunEvent.Compaction.class, result.event(),
                "compaction gave up after the first refusal: " + result.event());
        assertEquals(2, provider.requests.size(), "the view was not tried after the refusal");
        assertEquals(STUB, readOf(provider.requests.get(1), "r1"));
    }

    @Test
    void theCompactedHistoryKeepsTheFullRecentMessagesNotTheView() {
        Summarizer provider = new Summarizer(request -> false);
        List<ProviderMessage> history = new ArrayList<>(history());
        // Make the kept window hold a full result the view stubs.
        history.set(history.size() - 1, new ProviderMessage(ProviderMessage.Role.USER,
                List.of(new ToolResultContent("r3", big("KEPT"), false))));

        Compaction.Result result = compact(provider, List.copyOf(history), 1_000);

        ProviderMessage last = result.messages().getLast();
        assertEquals(big("KEPT"), ((ToolResultContent) last.content().getFirst()).output(),
                "the history compaction returns took a stub from the request view");
    }

    @Test
    void withoutAViewTheSummarizerReadsTheFullHistoryWhateverItsSize() {
        Summarizer provider = new Summarizer(request -> false);
        List<ProviderMessage> history = history();

        Compaction.Result result = Compaction.maybeCompact(provider, history, 50_000, 1_000,
                "main", new CancelSignal(), null, 4_000);

        assertInstanceOf(RunEvent.Compaction.class, result.event());
        assertEquals(big("R1"), readOf(provider.requests.getFirst(), "r1"));
    }

    private static int estimatedTokens(LlmProvider.ProviderRequest request) {
        long chars = request.system().length();
        for (ProviderMessage message : request.messages()) {
            for (ProviderContent content : message.content()) {
                chars += switch (content) {
                    case TextContent text -> text.text().length();
                    case ToolCallContent call -> call.name().length() + call.input().toString().length();
                    case ToolResultContent result -> result.output().length();
                    default -> 0;
                };
            }
        }
        return (int) (chars / 4);
    }
}
