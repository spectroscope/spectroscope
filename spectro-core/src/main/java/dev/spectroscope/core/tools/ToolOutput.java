package dev.spectroscope.core.tools;

/**
 * Shared output hygiene for tool and hook results — one cap, one truncation,
 * so run_command, grep, web_fetch and hook stdout cannot drift apart.
 */
public final class ToolOutput {

    /** The output clamp every tool/hook result shares. */
    public static final int MAX_OUTPUT_CHARS = 10_000;

    /** Static utility — no instances. */
    private ToolOutput() {
    }

    /**
     * Truncates to at most {@code max} chars without splitting a surrogate pair —
     * a cut between the halves of an astral-plane character (emoji, rare CJK)
     * would leave a lone surrogate that renders as a replacement glyph.
     *
     * @param s   the raw output text
     * @param max the upper bound in chars
     * @return s unchanged when within the bound, else the surrogate-safe prefix
     */
    public static String clip(String s, int max) {
        if (s.length() <= max) {
            return s;
        }
        int end = Character.isHighSurrogate(s.charAt(max - 1)) ? max - 1 : max;
        return s.substring(0, end);
    }

    /**
     * The same clamp from the OTHER end: keeps the LAST {@code max} chars and
     * marks the cut with a leading ellipsis.
     *
     * <p>Which end is kept is not a taste question, it is a question about what
     * the reader is looking for. A tool result is read from the top — the first
     * lines say what the command was doing. A TEST SUITE is read from the
     * bottom: it prints one line per passing case and its failure last, so a
     * head-clip of a 600-case suite returns nothing but "ok". Card 267's review
     * caught exactly that: the goal check's guidance handed the model 4.000
     * characters of passing lines under the sentence "the check ran and did not
     * pass".</p>
     *
     * @param s   the raw output text
     * @param max the upper bound in chars, ellipsis included
     * @return s unchanged when within the bound, else "…" plus the surrogate-safe suffix
     */
    public static String clipTail(String s, int max) {
        if (s.length() <= max) {
            return s;
        }
        int from = s.length() - max + 1;
        if (Character.isLowSurrogate(s.charAt(from))) {
            from++;   // never start on the trailing half of an astral character
        }
        return "\u2026" + s.substring(from);
    }
}
