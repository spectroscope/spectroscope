package dev.spectroscope.core.tools;

import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.session.CompactionThreshold;

/**
 * How much of one file a single read may put into the conversation (card 456).
 *
 * <p>Two bounds. A whole-file read succeeds when the file's estimated token
 * cost fits {@link #WINDOW_SHARE_PERCENT} of the context window the run has,
 * the window the loop derives for compaction (card 263). Above that, a fixed
 * {@link #FUSE_BYTES} stops giant logs, dumps and binaries whatever the
 * window. A whole-file decision reads the file's size only, never its bytes.</p>
 *
 * <p>This replaces a flat 50,000 bytes that had stood since the first commit
 * with no argument recorded for it. It refused a 56 kB CLAUDE.md under a
 * loaded window of 250,368 tokens and made the model page through it.</p>
 */
public final class ReadBudget {

    /**
     * The fixed fuse on one read, in bytes, whatever the window.
     *
     * <p>The largest window in the harness's own table ({@code ModelWindows},
     * 2,000,000 tokens) times the share times {@link #BYTES_PER_TOKEN} admits
     * 1,500,000 bytes. The fuse sits above that, at 2 MiB, so on every window
     * in that table the share decides and the fuse only stops a file none of
     * them would take: a log, a dump, a binary. A backend that publishes a
     * larger window of its own meets the fuse first.
     * ReadFuseAboveTheLargestTabledWindowTest derives the comparison from the
     * table, so a larger row turns it red. It is also
     * the only bound edit_file and grep use: neither puts the file into the
     * conversation, and the fuse caps the memory one call holds for it.</p>
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.BYTES)
    public static final long FUSE_BYTES = 2L * 1024 * 1024;

    /**
     * The share of the context window one whole-file read may take, in per cent.
     *
     * <p>Compaction trips at 70 % of the window ({@link CompactionThreshold}).
     * A read of a quarter leaves 45 of those 70 points for the system prompt,
     * the tool definitions and the rest of the conversation. A share near 70 %
     * would let one read trip compaction on the next turn, and the summary
     * would fold away the file the model had just asked for. On the owner's loaded window of
     * 250,368 tokens a quarter is 62,592 tokens, about 187 kB.</p>
     *
     * <p>Card 493 made it the shipped value of the key {@code readSharePercent}:
     * a run reads its share once when it starts, and the overloads below that
     * take a share judge with it. A share of 0 or less means the run names
     * none, and this value applies.</p>
     */
    @Governs(kind = Governs.Kind.SETTABLE, unit = Governs.Unit.PERCENT, key = "readSharePercent")
    public static final int WINDOW_SHARE_PERCENT = 25;

    /**
     * Bytes per token for the estimate, rounded down so a file is counted as
     * larger than it is rather than smaller.
     *
     * <p>Measured on 2026-09-29: the first 20,000 bytes of five files from the
     * product and home repositories (German and English markdown, Java, TSX,
     * JSON) were sent to the qwen2.5:3b tokenizer through Ollama, and the
     * prompt token count ({@code prompt_eval_count}) was read back. The German-heavy markdown came out at
     * 3.19 bytes per token, the other four between 3.43 and 4.61, all five
     * together at 3.72. The estimate takes 3, below the lowest file measured.
     * The context estimate elsewhere in the harness divides characters by 4;
     * the German markdown measured here comes out below that, which is why
     * this estimate does not reuse it.</p>
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.RATIO)
    public static final int BYTES_PER_TOKEN = 3;

    /** The window a read is judged against when the run states none: the
     *  level the loop compacts at when it has learned nothing, read from
     *  {@link CompactionThreshold} rather than kept as a second copy. */
    @Governs(kind = Governs.Kind.ALIAS, unit = Governs.Unit.TOKENS)
    private static final int UNKNOWN_WINDOW = CompactionThreshold.FALLBACK_THRESHOLD;

    /** Static utility, never instantiated. */
    private ReadBudget() {}

    /**
     * The window a read is judged against.
     *
     * @param window the window from the tool context, 0 or less when unknown
     * @return {@code window} when positive, else the compaction fallback
     */
    public static int windowOrFallback(int window) {
        return window > 0 ? window : UNKNOWN_WINDOW;
    }

    /**
     * The estimated token cost of a file of this size, rounded up.
     *
     * @param bytes the file size in bytes
     * @return the estimate at {@link #BYTES_PER_TOKEN}
     */
    public static long estimatedTokens(long bytes) {
        return (bytes + BYTES_PER_TOKEN - 1) / BYTES_PER_TOKEN;
    }

    /**
     * How many tokens one read may take under this window.
     *
     * @param window the window from the tool context, 0 or less when unknown
     * @return {@link #WINDOW_SHARE_PERCENT} of the window, rounded down
     */
    public static long tokenAllowance(int window) {
        return tokenAllowance(window, WINDOW_SHARE_PERCENT);
    }

    /**
     * The share a run reads with (card 493).
     *
     * @param share the run's share in per cent, 0 or less when it names none
     * @return {@code share} when positive, else {@link #WINDOW_SHARE_PERCENT}
     */
    public static int shareOrShipped(int share) {
        return share > 0 ? share : WINDOW_SHARE_PERCENT;
    }

    /**
     * How many tokens one read may take under this window and share.
     *
     * @param window the window from the tool context, 0 or less when unknown
     * @param share  the run's share in per cent, 0 or less for the shipped one
     * @return that share of the window, rounded down
     */
    public static long tokenAllowance(int window, int share) {
        return (long) windowOrFallback(window) * shareOrShipped(share) / 100;
    }

    /**
     * The largest file a whole read accepts under this window: the smaller of
     * the fuse and what the token allowance covers at the estimate.
     *
     * @param window the window from the tool context, 0 or less when unknown
     * @return the bound in bytes, inclusive
     */
    public static long wholeReadBytes(int window) {
        return wholeReadBytes(window, WINDOW_SHARE_PERCENT);
    }

    /**
     * The largest file a whole read accepts under this window and share.
     *
     * @param window the window from the tool context, 0 or less when unknown
     * @param share  the run's share in per cent, 0 or less for the shipped one
     * @return the bound in bytes, inclusive
     */
    public static long wholeReadBytes(int window, int share) {
        return Math.min(FUSE_BYTES, tokenAllowance(window, share) * BYTES_PER_TOKEN);
    }

    /**
     * Why a read of this many bytes is refused, or null when it may proceed.
     *
     * @param what   the noun the sentence starts with, "file" or "page"
     * @param bytes  the size in bytes
     * @param window the window from the tool context, 0 or less when unknown
     * @return the reason without the "ERROR: " prefix and without advice, or
     *         null when both bounds hold
     */
    public static String refusal(String what, long bytes, int window) {
        return refusal(what, bytes, window, WINDOW_SHARE_PERCENT);
    }

    /**
     * Why a read of this many bytes is refused under the run's share, or null
     * when it may proceed (card 493).
     *
     * @param what   the noun the sentence starts with, "file" or "page"
     * @param bytes  the size in bytes
     * @param window the window from the tool context, 0 or less when unknown
     * @param share  the run's share in per cent, 0 or less for the shipped one
     * @return the reason without the "ERROR: " prefix and without advice, or
     *         null when both bounds hold
     */
    public static String refusal(String what, long bytes, int window, int share) {
        if (bytes > FUSE_BYTES) {
            return what + " too large (" + bytes + " bytes, over the fixed fuse of "
                    + FUSE_BYTES + " bytes for one read)";
        }
        long tokens = estimatedTokens(bytes);
        long allowance = tokenAllowance(window, share);
        if (tokens > allowance) {
            return what + " too large to read at once (" + bytes + " bytes, about " + tokens
                    + " tokens at " + BYTES_PER_TOKEN + " bytes per token; one read may take "
                    + shareOrShipped(share) + " % of the " + windowOrFallback(window)
                    + " tokens context window, " + allowance + " tokens"
                    + (window > 0 ? "" : ", and the run stated no window, so this is the"
                    + " compaction fallback") + ")";
        }
        return null;
    }
}
