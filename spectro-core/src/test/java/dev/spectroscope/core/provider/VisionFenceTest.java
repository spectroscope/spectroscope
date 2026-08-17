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
