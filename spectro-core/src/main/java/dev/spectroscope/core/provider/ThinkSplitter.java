package dev.spectroscope.core.provider;

import dev.spectroscope.core.provider.LlmProvider.PTextDelta;
import dev.spectroscope.core.provider.LlmProvider.PThinkingDelta;
import dev.spectroscope.core.provider.LlmProvider.ProviderEvent;

/**
 * A tiny streaming state machine that splits inline {@code <think>…</think>}
 * reasoning out of answer content. Text inside the tags becomes
 * {@link PThinkingDelta}, everything else {@link PTextDelta}.
 *
 * <p>Shared by the local-backend providers: Ollama models may inline their
 * reasoning in {@code message.content} instead of the native thinking field,
 * and OpenAI-compatible servers stream raw tags whenever their own reasoning
 * parsing is off or misconfigured (LM Studio's "Reasoning Section Parsing"
 * does this same job server-side).</p>
 *
 * <p>Chunk boundaries are the hard part: a chunk may end mid-tag (e.g. {@code
 * "…done</thi"}). Any trailing run that starts with {@code '<'} and could still
 * grow into a tag is buffered and reconsidered when the next chunk arrives.</p>
 */
final class ThinkSplitter {

    private static final String OPEN = "<think>";
    private static final String CLOSE = "</think>";

    private boolean inside = false;
    // Holds a trailing partial that might be the start of a tag ("<", "</thi", …).
    private final StringBuilder carry = new StringBuilder();

    /**
     * Feed one content chunk; emits PTextDelta / PThinkingDelta into {@code out}.
     *
     * @param chunk the raw content delta as streamed (may end mid-tag)
     * @param out   receives the split events in stream order
     */
    void feed(String chunk, java.util.function.Consumer<ProviderEvent> out) {
        carry.append(chunk);
        StringBuilder text = new StringBuilder();
        StringBuilder think = new StringBuilder();

        int i = 0;
        while (i < carry.length()) {
            String target = inside ? CLOSE : OPEN;
            if (carry.charAt(i) == '<') {
                if (matchesAt(carry, i, target)) {
                    // A full tag: flush the accumulated side and flip state.
                    flush(inside ? think : text, inside, out);
                    inside = !inside;
                    i += target.length();
                    continue;
                }
                if (isPartialTagTail(carry, i)) {
                    // Could still grow into a tag next chunk — keep it in carry.
                    break;
                }
            }
            (inside ? think : text).append(carry.charAt(i));
            i++;
        }
        // Everything consumed except a possible partial tag tail stays in carry.
        carry.delete(0, i);
        flush(text, false, out);
        flush(think, true, out);
    }

    /**
     * Empties one side buffer into a single event and resets it; empty buffers emit nothing.
     *
     * @param buffer   the accumulated text of one side
     * @param thinking true to emit a PThinkingDelta, false for a PTextDelta
     * @param out      receives the event
     */
    private static void flush(StringBuilder buffer, boolean thinking,
                              java.util.function.Consumer<ProviderEvent> out) {
        if (buffer.length() == 0) {
            return;
        }
        String value = buffer.toString();
        buffer.setLength(0);
        out.accept(thinking ? new PThinkingDelta(value) : new PTextDelta(value));
    }

    /**
     * True if {@code needle} occurs at {@code pos} in {@code haystack}.
     *
     * @param haystack the buffer being scanned
     * @param pos      the index the comparison starts at
     * @param needle   the tag to test for
     * @return true on a full match at that position
     */
    private static boolean matchesAt(CharSequence haystack, int pos, String needle) {
        if (pos + needle.length() > haystack.length()) {
            return false;
        }
        for (int k = 0; k < needle.length(); k++) {
            if (haystack.charAt(pos + k) != needle.charAt(k)) {
                return false;
            }
        }
        return true;
    }

    /**
     * True if the run from {@code pos} is a proper prefix of either tag (a maybe-tag).
     *
     * @param haystack the buffer being scanned
     * @param pos      where the candidate run starts
     * @return true when the tail must be carried into the next chunk
     */
    private static boolean isPartialTagTail(CharSequence haystack, int pos) {
        String tail = haystack.subSequence(pos, haystack.length()).toString();
        return OPEN.startsWith(tail) || CLOSE.startsWith(tail);
    }
}
