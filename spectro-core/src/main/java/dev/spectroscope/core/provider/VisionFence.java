package dev.spectroscope.core.provider;

import dev.spectroscope.core.provider.LlmProvider.ImageContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.TextContent;

import java.util.ArrayList;
import java.util.List;

/**
 * The pure half of card 252's fence: what a history costs a model that cannot
 * see, and the copy that goes out instead.
 *
 * <p>Two rules, both learned from the wedge this fixes. First, the history is
 * never rewritten — the caller hands a history in and gets a COPY out, so the
 * agent's own {@code messages} list (and with it the session file, the user's
 * bubble and every resume) keeps the attachment. Second, an image is REPLACED
 * and not removed: a model handed "what is on this screenshot?" with no
 * screenshot in the request answers about a picture it never saw, and that is
 * the failure mode the ollama document arm already refuses to allow.</p>
 */
public final class VisionFence {

    /**
     * What stands where the image stood. Addressed to the model, in the
     * provider's own language: it has to read as an instruction, not as part of
     * the operator's prompt. This exact string is what the llm-wire record shows
     * in place of the image part — the proof that nothing was sent.
     */
    public static final String WITHHELD_MARKER =
            "[spectroscope: an image was attached here, but this model cannot process images, "
            + "so it was NOT sent. Say that you did not receive it instead of guessing what it showed.]";

    /** Static utility — never instantiated. */
    private VisionFence() {}

    /**
     * How many image blocks a history carries, everywhere in it.
     *
     * <p>Counting the whole history and not just the newest message is the point
     * of the card: the image the run attached is one, and the image a RESUMED
     * session re-expanded from {@code run_start} is another — the second is the
     * one that wedged the owner's session, turn after turn.</p>
     *
     * @param messages the history to scan; never mutated
     * @return the number of image blocks in it, 0 for a text-only history
     */
    public static int imageCount(List<ProviderMessage> messages) {
        return (int) messages.stream()
                .flatMap(message -> message.content().stream())
                .filter(ImageContent.class::isInstance)
                .count();
    }

    /**
     * A copy of the history in which every image block became
     * {@link #WITHHELD_MARKER}, at the same position.
     *
     * <p>Position matters: providers reorder content per their own rules
     * (anthropic puts tool results, then images, then documents, then text), and
     * a marker that drifted to the end would describe the wrong attachment in a
     * turn that carries two.</p>
     *
     * @param messages the history to fence; never mutated
     * @return the fenced copy, or the SAME list when it carries no image — the
     *         text-only path, which is nearly every turn, pays nothing
     */
    public static List<ProviderMessage> withhold(List<ProviderMessage> messages) {
        if (imageCount(messages) == 0) {
            return messages;
        }
        List<ProviderMessage> out = new ArrayList<>(messages.size());
        for (ProviderMessage message : messages) {
            List<ProviderContent> content = new ArrayList<>(message.content().size());
            for (ProviderContent piece : message.content()) {
                content.add(piece instanceof ImageContent
                        ? new TextContent(WITHHELD_MARKER) : piece);
            }
            out.add(new ProviderMessage(message.role(), List.copyOf(content)));
        }
        return List.copyOf(out);
    }
}
