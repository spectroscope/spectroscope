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
 * anthropic has no LOADED window to be asked about, which is not the same as
 * the number being unknown. A run on a 1,000,000-token model compacted at
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
 * <h2>Three things this table is honest about</h2>
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
 *
 * <p><b>A LIVE source exists for part of it, and this is not it.</b> The note
 * saying so was written next to the web table this class replaced, and it was
 * deleted with the table rather than moved — so the reason for a hand-typed
 * list read, for one review, as "nothing publishes this". Something does: the
 * Anthropic Models API answers {@code max_input_tokens} per model on
 * {@code GET /v1/models/{id}}, and the server ALREADY calls that exact endpoint
 * with the operator's key — {@code ModelCapabilityController.anthropicCapability}
 * reads the {@code capabilities} node of that same body and drops the rest.
 * openrouter publishes a window through its model API too, and the two backends
 * that are really a llama.cpp server answer {@code GET /props} with the
 * {@code n_ctx} the loaded model is running at (that one is already read, one
 * rung above this table, by {@code OpenAiCompatProvider.loadedWindowFromProps}).
 * Serving the published figure live would cost a field on the capability record
 * or a sibling endpoint, an async fetch keyed on (provider, model), and a
 * null-until-known state. Whatever publishes nothing keeps this table as its
 * fallback. Deliberately NOT built here — a table costs no key, no latency and
 * no network, and it works offline, which is where this house tests.</p>
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
