package dev.spectroscope.core.tools;

import dev.spectroscope.core.config.governing.Governs;

/**
 * Shared output hygiene for tool and hook results — one cap, one truncation,
 * so run_command, grep, web_fetch and hook stdout cannot drift apart.
 */
public final class ToolOutput {

    /**
     * The upper bound of the clamp on one tool or hook result, in characters.
     *
     * <p>A tool result takes its clamp from {@link #maxOutputChars(int)}, which
     * lowers this value on a small window (card 489). So does the reason of a
     * blocking hook, which enters the same request. A hook's output is captured
     * at this value before that.</p>
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int MAX_OUTPUT_CHARS = 10_000;

    /** Static utility — no instances. */
    private ToolOutput() {
    }

    /**
     * The clamp on one tool result under this window (card 489): the smaller of
     * {@link #MAX_OUTPUT_CHARS} and what {@code read_file} may put into the
     * conversation, {@link ReadBudget#tokenAllowance(int)} times
     * {@link ReadBudget#BYTES_PER_TOKEN}.
     *
     * <p>At a window of 8,192 tokens that is 6,144 characters. From a window
     * of 13,336 tokens up it is {@link #MAX_OUTPUT_CHARS}, so a large window
     * clamps where it always did. An unknown window is judged against the
     * compaction fallback, as for a read. The result is at least 1, so a clip
     * never gets a bound of zero.</p>
     *
     * @param window the window from the tool context, 0 or less when unknown
     * @return the clamp in characters, between 1 and {@link #MAX_OUTPUT_CHARS}
     */
    public static int maxOutputChars(int window) {
        long share = ReadBudget.tokenAllowance(window) * ReadBudget.BYTES_PER_TOKEN;
        return (int) Math.max(1, Math.min(MAX_OUTPUT_CHARS, share));
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
     * Clamps {@code output} so that it and the {@code notice} after it fit
     * {@code max} together, keeping the notice whole (card 489, criterion 5).
     *
     * <p>A notice is text a tool writes after its output: grep's line naming
     * the files it did not search, launch_list's line naming the entries it
     * skipped. A plain {@link #clip} over output and notice cuts the notice
     * first, so a smaller window would drop it. Here the output gives way from
     * its end instead. A notice that alone reaches {@code max} is cut like any
     * text.</p>
     *
     * @param output the tool's output
     * @param notice the text the tool writes after it
     * @param max    the upper bound in chars, notice included
     * @return output and notice when they fit, else the clipped output and the whole notice
     */
    public static String clipBefore(String output, String notice, int max) {
        if (output.length() + notice.length() <= max) {
            return output + notice;
        }
        if (notice.length() >= max) {
            return clip(output + notice, max);
        }
        return clip(output, max - notice.length()) + notice;
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
        if (from < s.length() && Character.isLowSurrogate(s.charAt(from))) {
            from++;   // never start on the trailing half of an astral character
        }
        return "\u2026" + s.substring(from);
    }
}
