package dev.spectroscope.core.session;

import dev.spectroscope.core.Agent;
import dev.spectroscope.core.session.CompactionThreshold.Derived;
import dev.spectroscope.core.session.CompactionThreshold.Source;
import dev.spectroscope.core.provider.LlmProvider.DocumentContent;
import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 488: the completion budget of a turn is
 * {@code min(maxTokens, window minus compaction threshold,
 * window minus estimated input minus INPUT_RESERVE_TOKENS)}, from the window
 * the run already uses for compaction, each bound with a floor of 512.
 *
 * <p>The rule lives in {@link CompactionThreshold#completionBudget}; the turn
 * loop and the compaction summarizer both read it, so no provider adapter
 * computes it on its own.</p>
 */
class CompletionBudgetTest {

    @Test
    void anEightKiloWindowLeavesTheReserveAndNotTheConfiguredBudget() {
        // 8,192 x 7 / 10 = 5,734 (integer); the reserve is 2,458.
        Derived derived = CompactionThreshold.derive(null, 8_192);
        assertEquals(5_734, derived.tokens(), "premise: the threshold on an 8,192 window");

        assertEquals(2_458, CompactionThreshold.completionBudget(derived, Agent.DEFAULT_MAX_TOKENS),
                "32,000 on an 8,192 window asks for more than the whole window");
        assertEquals(2_458, CompactionThreshold.completionBudget(derived, 16_000),
                "the OpenAI-compatible path's 16,000 is above the window too");
        assertEquals(1_000, CompactionThreshold.completionBudget(derived, 1_000),
                "a budget below the reserve is sent as it is");
    }

    @Test
    void everyWindowSourceIsClamped() {
        assertEquals(2_458, CompactionThreshold.completionBudget(
                CompactionThreshold.derive(null, 0, null, 8_192), Agent.DEFAULT_MAX_TOKENS),
                "a session window set from the ring (window_override)");
        assertEquals(12_000, CompactionThreshold.completionBudget(
                new Derived(28_000, Source.MODEL, 40_000), Agent.DEFAULT_MAX_TOKENS),
                "a published window");
        assertEquals(2_458, CompactionThreshold.completionBudget(
                new Derived(5_734, Source.WINDOW, 8_192), Agent.DEFAULT_MAX_TOKENS),
                "a loaded window");
    }

    @Test
    void aLargeWindowKeepsTheConfiguredBudget() {
        // 200,000 leaves a reserve of 60,000, above both budgets in the tree.
        Derived derived = CompactionThreshold.derive(null, 200_000);
        assertEquals(Agent.DEFAULT_MAX_TOKENS,
                CompactionThreshold.completionBudget(derived, Agent.DEFAULT_MAX_TOKENS));
        assertEquals(64_000, CompactionThreshold.completionBudget(
                CompactionThreshold.derive(null, 1_000_000), 64_000),
                "the clamp only takes budget away and never raises it to the reserve");
    }

    @Test
    void noKnownWindowLeavesTheBudgetAlone() {
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.completionBudget(
                CompactionThreshold.derive(null, 0), Agent.DEFAULT_MAX_TOKENS),
                "fallback: nothing is known about the window");
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.completionBudget(
                CompactionThreshold.derive(null, 0), Agent.DEFAULT_MAX_TOKENS, 1_000_000),
                "an input estimate alone says nothing without a window to hold it against");
    }

    @Test
    void anOperatorThresholdInsideAKnownWindowIsClampedLikeAnyOther() {
        // Review finding 1: the explicit compactionThreshold was exempt, so an
        // operator threshold of 5,000 on a published 8,192 window still sent
        // 32,000. The window is known, so the rule applies.
        assertEquals(3_192, CompactionThreshold.completionBudget(
                new Derived(5_000, Source.OVERRIDE, 8_192), Agent.DEFAULT_MAX_TOKENS));
        assertEquals(10_000, CompactionThreshold.completionBudget(
                new Derived(190_000, Source.OVERRIDE, 200_000), Agent.DEFAULT_MAX_TOKENS));
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.completionBudget(
                new Derived(100_000, Source.OVERRIDE, 200_000), Agent.DEFAULT_MAX_TOKENS),
                "a reserve above the budget takes nothing away");
    }

    @Test
    void anOperatorThresholdAtOrAboveTheWindowGetsTheFloor() {
        // Decided in round three of card 488: the clamp applies under an
        // explicit threshold as under any other source. A threshold at or above
        // the window leaves no reserve, so every answer gets the floor.
        assertEquals(CompactionThreshold.MIN_COMPLETION_TOKENS, CompactionThreshold.completionBudget(
                new Derived(200_000, Source.OVERRIDE, 200_000), Agent.DEFAULT_MAX_TOKENS));
        assertEquals(CompactionThreshold.MIN_COMPLETION_TOKENS, CompactionThreshold.completionBudget(
                new Derived(300_000, Source.OVERRIDE, 200_000), Agent.DEFAULT_MAX_TOKENS));
        assertEquals(300, CompactionThreshold.completionBudget(
                new Derived(300_000, Source.OVERRIDE, 200_000), 300),
                "the floor never raises a budget the operator set below it");
    }

    @Test
    void anOperatorThresholdWithNoKnownWindowIsClampedByTheWindowItImplies() {
        // Under an explicit threshold the backend is never asked for its window
        // (card 263), so the window is 0. The threshold is 70 % of the window it
        // was meant for, so that window is the threshold times 10 / 7, rounded up.
        assertEquals(7_143, CompactionThreshold.impliedWindow(new Derived(5_000, Source.OVERRIDE, 0)),
                "5,000 x 10 / 7 = 7,142.9");
        assertEquals(2_143, CompactionThreshold.completionBudget(
                new Derived(5_000, Source.OVERRIDE, 0), Agent.DEFAULT_MAX_TOKENS),
                "7,143 - 5,000");
        assertEquals(2_143, CompactionThreshold.completionBudget(
                CompactionThreshold.derive(5_000, 0), Agent.DEFAULT_MAX_TOKENS),
                "the same through derive, which leaves the window at 0 under an override");
        assertEquals(2_458, CompactionThreshold.completionBudget(
                new Derived(5_734, Source.OVERRIDE, 0), Agent.DEFAULT_MAX_TOKENS),
                "the threshold of an 8,192 window implies 8,192 again");
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.completionBudget(
                new Derived(100_000, Source.OVERRIDE, 0), Agent.DEFAULT_MAX_TOKENS),
                "100,000 implies 142,858, whose reserve of 42,858 takes nothing away");
        assertEquals(7_143 - 6_000 - CompactionThreshold.INPUT_RESERVE_TOKENS,
                CompactionThreshold.completionBudget(
                        new Derived(5_000, Source.OVERRIDE, 0), Agent.DEFAULT_MAX_TOKENS, 6_000),
                "the input bound holds against the implied window too");
        assertEquals(0, CompactionThreshold.impliedWindow(CompactionThreshold.derive(null, 0)),
                "the fallback threshold implies nothing: no window was learned");
        assertEquals(8_192, CompactionThreshold.impliedWindow(new Derived(5_000, Source.OVERRIDE, 8_192)),
                "a known window is the window, whatever the threshold");
    }

    @Test
    void aTurnWhoseInputPassedTheThresholdGetsWhatTheWindowHasLeft() {
        // Review finding 2: on the scripted run, the turn on which one tool
        // result pushed the input to 6,439 still asked for 2,458 on 8,192.
        Derived derived = CompactionThreshold.derive(null, 8_192);
        assertEquals(8_192 - 6_439 - CompactionThreshold.INPUT_RESERVE_TOKENS,
                CompactionThreshold.completionBudget(derived, Agent.DEFAULT_MAX_TOKENS, 6_439),
                "window minus input minus the reserve for what the estimate does not see");
        assertEquals(2_458, CompactionThreshold.completionBudget(derived, Agent.DEFAULT_MAX_TOKENS, 3_000),
                "below the threshold the reserve is the tighter bound");
        assertEquals(CompactionThreshold.MIN_COMPLETION_TOKENS,
                CompactionThreshold.completionBudget(derived, Agent.DEFAULT_MAX_TOKENS, 9_000),
                "input above the window: the floor, never zero or less");
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.completionBudget(
                CompactionThreshold.derive(null, 200_000), Agent.DEFAULT_MAX_TOKENS, 1_000),
                "a large window and a small input change nothing");
        assertEquals(1_000, CompactionThreshold.completionBudget(derived, 1_000, 6_439),
                "the configured budget still wins when it is lower");
    }

    @Test
    void theInputReserveIsNamedAndSized() {
        // The reserve on the input bound covers what the backend counts and
        // the character estimate does not see: the chat template's role
        // markers and tool wrapping, and the JSON framing. Its value is
        // measured and recorded in card 488, "Result after round three".
        assertEquals(256, CompactionThreshold.INPUT_RESERVE_TOKENS);
        assertEquals(8_192 - 5_600 - 256, CompactionThreshold.completionBudget(
                CompactionThreshold.derive(null, 8_192), Agent.DEFAULT_MAX_TOKENS, 5_600),
                "below the threshold of 5,734 the input bound can already decide: 2,336 < 2,458");
        assertEquals(Agent.DEFAULT_MAX_TOKENS, CompactionThreshold.completionBudget(
                CompactionThreshold.derive(null, 200_000), Agent.DEFAULT_MAX_TOKENS, 139_999),
                "at 200,000 an input just under the threshold still leaves more than 32,000");
    }

    @Test
    void anImageCountsAsAFixedNumberOfTokensWhateverItsSize() {
        // Review finding of round three: the base64 characters of a pasted
        // screenshot were counted over four, so 1 MB of PNG read as 349,526
        // tokens. A backend counts an image by its pixels after its own
        // resizing; 4,784 is the most one image costs on any Claude model.
        String small = Base64.getEncoder().encodeToString(new byte[100]);
        String large = Base64.getEncoder().encodeToString(new byte[1 << 20]);
        assertEquals(CompactionThreshold.IMAGE_TOKENS,
                CompactionThreshold.attachmentTokens(new ImageContent("image/png", small)));
        assertEquals(CompactionThreshold.IMAGE_TOKENS,
                CompactionThreshold.attachmentTokens(new ImageContent("image/png", large)));
        assertEquals(4_784, CompactionThreshold.IMAGE_TOKENS);
        assertEquals(0, CompactionThreshold.attachmentTokens(new TextContent("x".repeat(400))),
                "text is counted by its characters, not here");
    }

    @Test
    void aPdfCountsPerPage() {
        // A PDF page costs its text and an image of the page (Anthropic, PDF
        // support, "Estimate your costs": 1,500 to 3,000 text tokens a page,
        // plus the image cost). The pages are counted from the file.
        String threePages = pdf(3, 1 << 20);
        assertEquals(3 * (CompactionThreshold.PDF_PAGE_TEXT_TOKENS + CompactionThreshold.IMAGE_TOKENS),
                CompactionThreshold.attachmentTokens(new DocumentContent("application/pdf", threePages, "a.pdf")));
        assertEquals(CompactionThreshold.PDF_PAGE_TEXT_TOKENS + CompactionThreshold.IMAGE_TOKENS,
                CompactionThreshold.attachmentTokens(new DocumentContent("application/pdf", pdf(0, 4_000), "b.pdf")),
                "no page object found (pages inside compressed object streams): one page");
        assertEquals(3_000, CompactionThreshold.PDF_PAGE_TEXT_TOKENS);
    }

    @Test
    void theBackendsDensityIsReadFromTheTextAloneWhenTheRequestCarriedAttachments() {
        // The previous request carried one image; the backend's 6,284 is 4,784
        // for the image and 1,500 for 4,000 characters of text.
        assertEquals(3_000 + 4_784, CompactionThreshold.inputEstimate(8_000, 4_784, 4_000, 4_784, 6_284));
        assertEquals(1_000 + 4_784, CompactionThreshold.inputEstimate(4_000, 4_784, 0, 0, 0),
                "nothing reported yet: chars over four plus the attachments");
        assertEquals(2_000, CompactionThreshold.inputEstimate(8_000, 0, 4_000, 4_784, 4_000),
                "an attachment estimate above the backend's count never lowers the text below chars/4");
    }

    /** A stand-in PDF: the header, {@code pages} page objects and padding up to about {@code size} bytes. */
    private static String pdf(int pages, int size) {
        StringBuilder text = new StringBuilder("%PDF-1.4\n1 0 obj << /Type /Pages /Count ")
                .append(pages).append(" >> endobj\n");
        for (int page = 0; page < pages; page++) {
            text.append(page + 2).append(" 0 obj << /Type /Page /Parent 1 0 R >> endobj\n");
        }
        while (text.length() < size) {
            text.append("% padding of the stand-in file\n");
        }
        text.append("%%EOF\n");
        return Base64.getEncoder().encodeToString(text.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    @Test
    void theInputEstimateIsCharsOverFourOrTheBackendsOwnDensityIfThatIsHigher() {
        assertEquals(1_000, CompactionThreshold.inputEstimate(4_000, 0, 0), "nothing reported yet");
        assertEquals(1_001, CompactionThreshold.inputEstimate(4_001, 0, 0), "rounded up");
        assertEquals(3_000, CompactionThreshold.inputEstimate(8_000, 4_000, 1_500),
                "the backend counted 1,500 for 4,000 characters, so 8,000 are 3,000");
        assertEquals(3_001, CompactionThreshold.inputEstimate(8_001, 4_000, 1_500), "rounded up");
        assertEquals(2_000, CompactionThreshold.inputEstimate(8_000, 4_000, 500),
                "a backend that counts fewer never lowers the estimate below chars/4");
        assertEquals(0, CompactionThreshold.inputEstimate(0, 0, 0));
    }

    @Test
    void aReserveOfZeroOrLessIsSentAsTheFloor() {
        // A window of 1 has a threshold of 1 (the share never rounds to zero),
        // so the difference is 0.
        Derived one = CompactionThreshold.derive(null, 1);
        assertEquals(0, one.window() - one.tokens(), "premise: a difference of zero");
        assertEquals(CompactionThreshold.MIN_COMPLETION_TOKENS,
                CompactionThreshold.completionBudget(one, Agent.DEFAULT_MAX_TOKENS));
        assertEquals(CompactionThreshold.MIN_COMPLETION_TOKENS,
                CompactionThreshold.completionBudget(
                        new Derived(9_000, Source.WINDOW_OVERRIDE, 8_192), Agent.DEFAULT_MAX_TOKENS),
                "a negative difference");
        assertEquals(100, CompactionThreshold.completionBudget(one, 100),
                "the floor never raises a budget the operator set below it");
        assertEquals(512, CompactionThreshold.MIN_COMPLETION_TOKENS, "the floor's value");
    }

    @Test
    void theFloorDecidesUpToAWindowOf1703Tokens() {
        // The measurement the card names: the largest window whose reserve is
        // below the floor, found by walking every window up to 20,000.
        int largest = 0;
        for (int window = 1; window <= 20_000; window++) {
            Derived derived = CompactionThreshold.derive(null, window);
            if (window - derived.tokens() < CompactionThreshold.MIN_COMPLETION_TOKENS) {
                largest = window;
            }
        }
        assertEquals(1_703, largest);
    }

    @Test
    void theSummarizerReadsTheSameRule() {
        Derived[] cases = {
            CompactionThreshold.derive(null, 0),
            CompactionThreshold.derive(null, 1),
            CompactionThreshold.derive(null, 1_024),
            CompactionThreshold.derive(null, 8_192),
            CompactionThreshold.derive(null, 200_000),
            CompactionThreshold.derive(5_000, 0),
            new Derived(190_000, Source.OVERRIDE, 200_000),
            new Derived(200_000, Source.OVERRIDE, 200_000),
            new Derived(7_000, Source.WINDOW_OVERRIDE, 10_000),
            new Derived(28_000, Source.MODEL, 40_000),
        };
        for (Derived derived : cases) {
            assertEquals(CompactionThreshold.completionBudget(derived, Agent.DEFAULT_MAX_TOKENS),
                    CompactionThreshold.summaryBudget(derived), derived.toString());
        }
    }
}
