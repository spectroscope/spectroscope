package dev.spectroscope.core.provider;

import dev.spectroscope.core.provider.LlmProvider.DocumentContent;
import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 252: the pure half of the fence — counting the images a history carries
 * and building the copy that goes to a model which cannot see them.
 *
 * <p>A drop would be cheaper than a replacement, and wrong: a model handed a
 * prompt about "this screenshot" with no screenshot in it answers about a
 * picture it never saw. The marker is what makes the withholding honest on the
 * wire, and the llm-wire record then shows exactly that — no image part, one
 * line of text naming what happened.</p>
 */
class VisionFenceTest {

    private static final ImageContent SHOT = new ImageContent("image/png", "aWJt");

    @Test
    void itCountsEveryImageInTheWholeHistoryNotJustTheFirstMessage() {
        List<ProviderMessage> history = List.of(
                new ProviderMessage(ProviderMessage.Role.USER,
                        List.of(SHOT, new TextContent("what is this?"))),
                new ProviderMessage(ProviderMessage.Role.ASSISTANT,
                        List.of(new TextContent("I cannot see it."))),
                new ProviderMessage(ProviderMessage.Role.USER,
                        List.of(new ToolResultContent("call_1", "done", false), SHOT, SHOT)));

        assertEquals(3, VisionFence.imageCount(history));
        assertEquals(0, VisionFence.imageCount(List.of()));
    }

    @Test
    void theImageBecomesAMarkerAndEverythingElseStaysWhereItWas() {
        List<ProviderMessage> withheld = VisionFence.withhold(List.of(
                new ProviderMessage(ProviderMessage.Role.USER, List.of(
                        new ToolResultContent("call_1", "output", false),
                        SHOT,
                        new DocumentContent("application/pdf", "UERG", "paper.pdf"),
                        new TextContent("summarize it")))));

        List<LlmProvider.ProviderContent> content = withheld.getFirst().content();
        assertEquals(4, content.size(), "the piece is replaced, never removed");
        assertInstanceOf(ToolResultContent.class, content.get(0));
        TextContent marker = assertInstanceOf(TextContent.class, content.get(1),
                "the image sits where the image sat");
        assertTrue(marker.text().contains("cannot process images"), marker.text());
        assertInstanceOf(DocumentContent.class, content.get(2),
                "a PDF is a different channel and none of this fence's business");
        assertEquals("summarize it", ((TextContent) content.get(3)).text());
        assertEquals(0, VisionFence.imageCount(withheld));
    }

    /** Answers a fixed sight and counts how often it was asked. */
    private static final class Asked implements LlmProvider {
        final LlmProvider.Vision sight;
        int questions;

        Asked(LlmProvider.Vision sight) {
            this.sight = sight;
        }

        @Override
        public Vision vision() {
            questions++;
            return sight;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            throw new UnsupportedOperationException("never streamed in this test");
        }
    }

    private static final List<ProviderMessage> WITH_IMAGE = List.of(
            new ProviderMessage(ProviderMessage.Role.USER,
                    List.of(SHOT, new TextContent("what is this?"))));

    @Test
    void onlyBlindnessClosesTheFenceAndItSaysHowMuchItKeptBack() {
        // The one decision every request builder asks — the turn loop and the
        // compaction summarizer alike. Blind withholds and reports the count;
        // SEES and UNKNOWN hand the SAME list straight back, so an untouched
        // request stays byte-identical to what it was before this card.
        VisionFence.Fenced blind = VisionFence.fence(new Asked(LlmProvider.Vision.BLIND), WITH_IMAGE);
        assertEquals(1, blind.withheld());
        assertEquals(0, VisionFence.imageCount(blind.messages()));

        for (LlmProvider.Vision sight : List.of(LlmProvider.Vision.SEES, LlmProvider.Vision.UNKNOWN)) {
            VisionFence.Fenced sends = VisionFence.fence(new Asked(sight), WITH_IMAGE);
            assertEquals(0, sends.withheld(), sight + " withholds nothing");
            assertSame(WITH_IMAGE, sends.messages(), sight + " sends the history as it stands");
        }
        // A caller without a provider is "nothing known", which sends.
        assertSame(WITH_IMAGE, VisionFence.fence(null, WITH_IMAGE).messages());
    }

    @Test
    void aTextOnlyHistoryNeverEvenAsksWhetherTheModelCanSee() {
        // The order of the two questions is the cost claim: asking a provider can
        // mean a round trip (ollama probes /api/show), and nearly every turn of
        // nearly every session carries no picture at all.
        Asked provider = new Asked(LlmProvider.Vision.BLIND);
        List<ProviderMessage> plain = List.of(new ProviderMessage(
                ProviderMessage.Role.USER, List.of(new TextContent("hi"))));

        VisionFence.Fenced fenced = VisionFence.fence(provider, plain);

        assertEquals(0, provider.questions, "no image, no question");
        assertSame(plain, fenced.messages());
        assertEquals(0, fenced.withheld());
    }

    @Test
    void aHistoryWithoutImagesComesBackUntouched() {
        // The fence runs on every turn of every run. An identity that allocates a
        // fresh history each time would still be correct, but the same list back
        // is what proves the text-only path pays nothing at all.
        List<ProviderMessage> plain = List.of(new ProviderMessage(
                ProviderMessage.Role.USER, List.of(new TextContent("hi"))));
        assertSame(plain, VisionFence.withhold(plain));
    }
}
