package dev.spectroscope.core.session;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 366: the published-window table, moved out of the web and into the code
 * that derives the compaction threshold.
 *
 * <p>The cases below are DERIVED from {@link ModelWindows#TABLE} wherever they
 * can be. A test that retypes a hand-list is two copies of the same claim and
 * pins neither (card 312 found that three times in one card), so the ordering
 * and reachability of the rows are asserted against the list itself. Only the
 * facts the list cannot state about itself — a real model id nobody typed into
 * it, the regression that made this table famous — are written out.</p>
 */
class ModelWindowsTest {

    @Test
    void everyRowInTheTableIsReachableThroughItsOwnPrefix() {
        // The defect this pins is ORDER: putting "claude" above "claude-opus"
        // shadows four rows at once, silently, and the shadowed models keep
        // answering with a plausible number. Derived from the table, so a new
        // row is covered the day it is added and not the day someone remembers.
        for (ModelWindows.Entry row : ModelWindows.TABLE) {
            assertEquals(row.tokens(), ModelWindows.windowFor(row.prefix()),
                    "a row shadowed by an earlier prefix: " + row.prefix());
        }
    }

    @Test
    void aFamilyPrefixCarriesTheWholeFamilyAndNotJustTheBareName() {
        // The ids that actually ride the wire are the prefix plus a version.
        for (ModelWindows.Entry row : ModelWindows.TABLE) {
            assertEquals(row.tokens(), ModelWindows.windowFor(row.prefix() + "-4-6-20260514"),
                    "a versioned id must land on its family: " + row.prefix());
        }
    }

    @Test
    void theFableRegressionStaysFixed() {
        // The reason the rows are ordered at all. claude-fable-5 starts with
        // "claude" but with neither "claude-opus" nor "claude-sonnet"; under the
        // pair that stood in the web it fell to the legacy 200k row and the ring
        // read 379 % in red on a healthy session.
        assertEquals(1_000_000, ModelWindows.windowFor("claude-fable-5"));
        assertEquals(ModelWindows.windowFor("claude-opus-4-6"),
                ModelWindows.windowFor("claude-fable-5"));
    }

    @Test
    void theLegacyClaudeRowIsStillReachedByAnOlderName() {
        // The bare "claude" row is not decoration: every 3.x id lands on it.
        assertEquals(200_000, ModelWindows.windowFor("claude-3-5-sonnet-20241022"));
        assertEquals(200_000, ModelWindows.windowFor("claude-haiku-4-5"));
    }

    @Test
    void aModelIdNobodyPublishedTeachesNothing() {
        // 0 is "nothing known", exactly as LlmProvider.contextWindow() means it.
        // Every local id lands here, which is why the loaded-instance probe is
        // the tier above this one and not below it.
        assertEquals(0, ModelWindows.windowFor("qwen3.8-flash-next@q4_k_xl"));
        assertEquals(0, ModelWindows.windowFor("deepseek-v4-flash-0731@iq1_m"));
        assertEquals(0, ModelWindows.windowFor("llama-3.3-70b"));
        assertEquals(0, ModelWindows.windowFor(""));
        assertEquals(0, ModelWindows.windowFor(null));
    }

    @Test
    void theCasesTheWebTableCarriedBeforeTheMoveStillHold() {
        // Card 366 moved this table out of spectro-web/src/components/
        // contextWindow.ts, and these are the exact ids its suite named. They
        // are here so the move cost nothing: a real model id is knowledge, and
        // deleting the file it was tested in would otherwise delete it.
        assertEquals(1_000_000, ModelWindows.windowFor("claude-opus-4-8"));
        assertEquals(1_000_000, ModelWindows.windowFor("claude-sonnet-5"));
        assertEquals(1_000_000, ModelWindows.windowFor("claude-mythos-5"));
        assertEquals(200_000, ModelWindows.windowFor("claude-haiku-4-5"));
        assertEquals(200_000, ModelWindows.windowFor("claude-3-5-sonnet"));
        assertEquals(128_000, ModelWindows.windowFor("gpt-4o"));
        assertEquals(128_000, ModelWindows.windowFor("gpt-4o-mini"));
        assertEquals(1_000_000, ModelWindows.windowFor("gpt-4.1"));
        assertEquals(1_000_000, ModelWindows.windowFor("gpt-5.6-luna"));
        assertEquals(2_000_000, ModelWindows.windowFor("gemini-1.5-pro"));
        assertEquals(1_000_000, ModelWindows.windowFor("gemini-2.5-flash"));
        assertEquals(0, ModelWindows.windowFor("local-model"));
        assertEquals(0, ModelWindows.windowFor("qwen3"));
        assertEquals(0, ModelWindows.windowFor("llama4"));
    }

    @Test
    void theIdIsMatchedWithoutCaringAboutCase() {
        // Operators type model ids by hand into settings, and LM Studio's own
        // listing mixes cases in publisher-qualified keys.
        assertEquals(1_000_000, ModelWindows.windowFor("Claude-Opus-4-6"));
        assertEquals(128_000, ModelWindows.windowFor("GPT-4o"));
    }

    @Test
    void theTableIsOrderedSoThatNoPrefixSitsAboveOneItWouldSwallow() {
        // The structural half of the first test: it is not enough that today's
        // rows resolve — a row added ABOVE a longer sibling must be caught even
        // when both happen to carry the same number.
        for (int i = 0; i < ModelWindows.TABLE.size(); i++) {
            for (int j = i + 1; j < ModelWindows.TABLE.size(); j++) {
                String earlier = ModelWindows.TABLE.get(i).prefix();
                String later = ModelWindows.TABLE.get(j).prefix();
                assertTrue(!later.startsWith(earlier),
                        "'" + earlier + "' shadows '" + later + "': the longer family goes first");
            }
        }
    }
}
