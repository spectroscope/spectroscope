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
}
