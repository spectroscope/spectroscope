package dev.spectroscope.core.session;

import java.util.List;
import java.util.Locale;

/**
 * A published context window per model family — the cloud half of the threshold
 * question (card 366).
 *
 * <h2>Why this is not the same knowledge as a loaded window</h2>
 *
 * <p>{@link dev.spectroscope.core.provider.LlmProvider#contextWindow()} asks the
 * SERVER what the instance serving the next request holds. A hosted model has no
 * such instance and nothing to overrun: its window is a published, fixed
 * property of the model id. The interface's own note said a provider that
 * "cannot ask" lands on the fallback, and that word was doing too much work —
 * anthropic cannot ask because there is nothing to ask, not because the number
 * is unknown. A run on a 1,000,000-token model compacted at
 * {@link CompactionThreshold#FALLBACK_THRESHOLD}, 10 % of its window.</p>
 *
 * <h2>Where this table came from, and where it used to live</h2>
 *
 * <p>It lived in {@code spectro-web/src/components/contextWindow.ts}, where it
 * could colour a gauge and could not move a threshold — the wrong side of the
 * wire. Card 366 moved it here, beside the code that derives the threshold, so
 * one table serves both and the web reads the answer off {@code context_info}
 * instead of keeping a second copy of it. Values from the vendors' own docs
 * (July 2026, unchanged when moved on 2026-09-01):</p>
 *
 * <ul>
 *   <li>Claude: Opus 4.6+ / Sonnet 5 / Fable 5 / Mythos 5 = 1M, Haiku 4.5 and
 *       legacy = 200k
 *       (platform.claude.com/docs/en/build-with-claude/context-windows)</li>
 *   <li>OpenAI: GPT-4o = 128k, GPT-4.1 and GPT-5.x = ~1M
 *       (openai.com/index/gpt-4-1, openai.com/index/introducing-gpt-5-5)</li>
 *   <li>Gemini: 1.5 Pro up to 2M, 2.5 Pro/Flash = 1M
 *       (ai.google.dev/gemini-api/docs/long-context)</li>
 * </ul>
 *
 * <h2>Two things this table is honest about</h2>
 *
 * <p><b>It is a guess by prefix and it has been wrong.</b> {@code claude-fable-5}
 * starts with {@code claude} but with neither {@code claude-opus} nor
 * {@code claude-sonnet}, fell to the legacy 200k row, and the web ring read
 * 379 % in red on a healthy session. The rows are ordered longest-family-first
 * for exactly that reason, and {@link #TABLE} is the single list both the
 * lookup and its test read — a hand-list guarded by a test that retypes the
 * hand-list guards nothing.</p>
 *
 * <p><b>It is keyed on the model id alone, so a LOCAL server answering to a
 * hosted id is read as that model.</b> A llama.cpp server serving 8,192 tokens
 * under the alias {@code gpt-4o} would be credited with 128,000 here. That case
 * is real but narrow: it needs a local backend that both borrows a vendor id AND
 * states no loaded window, because a stated loaded window always wins
 * ({@link CompactionThreshold#derive(Integer, int, String)}). The alternative —
 * keying on the provider label — would blind every gateway that speaks the
 * OpenAI wire for a real hosted model, which is the commoner case.</p>
 */
public final class ModelWindows {

    /**
     * One family's published window.
     *
     * @param prefix the lowercase model-id prefix this row claims
     * @param tokens the published context window in tokens
     */
    record Entry(String prefix, int tokens) {}

    /**
     * The whole table, longest family first so no row can shadow a more
     * specific one. Package-private on purpose: the test derives its cases
     * from this list rather than retyping it.
     */
    static final List<Entry> TABLE = List.of(
            new Entry("claude-opus", 1_000_000),
            new Entry("claude-sonnet", 1_000_000),
            new Entry("claude-fable", 1_000_000),
            new Entry("claude-mythos", 1_000_000),
            new Entry("claude", 200_000),
            new Entry("gpt-4o", 128_000),
            new Entry("gpt-4.1", 1_000_000),
            new Entry("gpt-5", 1_000_000),
            new Entry("gemini-1.5-pro", 2_000_000),
            new Entry("gemini", 1_000_000));

    /** Static utility — never instantiated. */
    private ModelWindows() {}

    /**
     * The published context window for a model id.
     *
     * @param model the model id the run is addressed to, or null when the
     *              provider names none
     * @return the published window in tokens, or 0 when this table knows
     *         nothing about the id — the same "0 is not knowledge" convention
     *         {@code LlmProvider.contextWindow()} uses
     */
    public static int windowFor(String model) {
        if (model == null) {
            return 0;
        }
        String id = model.toLowerCase(Locale.ROOT);
        for (Entry row : TABLE) {
            if (id.startsWith(row.prefix())) {
                return row.tokens();
            }
        }
        return 0;
    }
}
