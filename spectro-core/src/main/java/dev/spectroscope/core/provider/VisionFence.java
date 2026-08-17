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
 *
 * <p><b>{@link #fence} is the whole decision, and every place that builds a
 * provider request out of a history asks it.</b> The first cut of this card put
 * the decision inline in the agent's turn loop, and an adversarial verifier
 * found what that costs: the compaction summarizer assembles its OWN request
 * from the same messages, so a long session on a blind model still wedged —
 * later, at compaction time, instead of on the first turn. A second copy of the
 * rule would have had the same shape. One method answers it for both.</p>
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

    /**
     * The outcome of one fencing decision: the history to send, and how many
     * images it cost.
     *
     * @param messages what to hand the provider — the input list itself when
     *                 nothing was withheld, a fenced copy when something was
     * @param withheld how many image blocks were kept back; 0 means the request
     *                 is untouched, which is the only case a caller may stay
     *                 silent about
     */
    public record Fenced(List<ProviderMessage> messages, int withheld) {}

    /** Static utility — never instantiated. */
    private VisionFence() {}

    /**
     * The whole fence in one call: does this provider's model see, and if not,
     * what goes out instead.
     *
     * <p>Every place that builds a {@link LlmProvider.ProviderRequest} out of a
     * conversation asks THIS — the agent's turn loop and the compaction
     * summarizer both, because the summarizer's request is a second door into the
     * same provider and an unfenced door is the whole defect back again.</p>
     *
     * <p>Order of the two questions is deliberate: the images are counted first,
     * so a text-only history never asks {@link LlmProvider#vision()} at all.
     * That question can cost a round trip (ollama probes {@code /api/show}), and
     * nearly every turn of nearly every session carries no picture.</p>
     *
     * @param provider the provider the request is destined for; null is treated
     *                 as "nothing known", which sends
     * @param messages the history about to be sent; never mutated
     * @return what to send, plus the number of images kept back (0 when the
     *         history came back untouched)
     */
    public static Fenced fence(LlmProvider provider, List<ProviderMessage> messages) {
        int images = imageCount(messages);
        if (images == 0 || provider == null || provider.vision() != LlmProvider.Vision.BLIND) {
            return new Fenced(messages, 0);
        }
        return new Fenced(withhold(messages), images);
    }

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
