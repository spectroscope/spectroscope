package dev.spectroscope.core.session;

import dev.spectroscope.core.session.CompactionThreshold.Derived;
import dev.spectroscope.core.session.CompactionThreshold.Source;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.IntSupplier;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 391: the window the BACKEND publishes for a model id, on the MODEL rung
 * and consulted before {@link ModelWindows}.
 *
 * <p>The two figures are what ollama 0.32.1 answered on {@code POST /api/show}
 * on 2026-09-24: {@code glm_dsa_moe.context_length} 1,048,576 for
 * {@code glm-5.3:cloud} and {@code minimax-m3.context_length} 512,000 for
 * {@code minimax-m3:cloud}. Neither id is in {@link ModelWindows}, and neither
 * model has a loaded instance on the machine, so before this card both
 * compacted at 100,000.</p>
 */
class PublishedWindowDerivationTest {

    /** A question that counts how often it is asked. */
    private static IntSupplier counted(AtomicInteger asked, int answer) {
        return () -> {
            asked.incrementAndGet();
            return answer;
        };
    }

    @Test
    void glmOverOllamaCloudCompactsAtSeventyPercentOfWhatTheBackendPublishes() {
        Derived derived = CompactionThreshold.derive(
                null, () -> 0, () -> 1_048_576, "glm-5.3:cloud", 0);

        assertEquals(new Derived(734_003, Source.MODEL, 1_048_576), derived);
    }

    @Test
    void minimaxOverOllamaCloudCompactsAtSeventyPercentOfItsFigureToo() {
        Derived derived = CompactionThreshold.derive(
                null, () -> 0, () -> 512_000, "minimax-m3:cloud", 0);

        assertEquals(new Derived(358_400, Source.MODEL, 512_000), derived);
    }

    @Test
    void theBackendsFigureIsConsultedBeforeTheTable() {
        // ModelWindows says 1,000,000 for this id; the backend serving it says
        // less, and the backend is the one that answers the request.
        Derived derived = CompactionThreshold.derive(
                null, () -> 0, () -> 200_000, "claude-opus-4-6", 0);

        assertEquals(new Derived(140_000, Source.MODEL, 200_000), derived);
    }

    @Test
    void aLoadedWindowOutranksThePublishedOneAndThePublishedOneIsNotAsked() {
        AtomicInteger published = new AtomicInteger();

        Derived derived = CompactionThreshold.derive(
                null, () -> 32_768, counted(published, 1_048_576), "glm-5.3:cloud", 0);

        assertEquals(new Derived(22_937, Source.WINDOW, 32_768), derived);
        assertEquals(0, published.get(), "the loaded window decides, so nobody asks for the other");
    }

    @Test
    void anExplicitThresholdAsksNeitherQuestion() {
        AtomicInteger loaded = new AtomicInteger();
        AtomicInteger published = new AtomicInteger();

        Derived derived = CompactionThreshold.derive(
                50_000, counted(loaded, 32_768), counted(published, 1_048_576),
                "glm-5.3:cloud", 0);

        assertEquals(new Derived(50_000, Source.OVERRIDE, 0), derived,
                "the window under an override is the table's, and the table knows no glm");
        assertEquals(0, loaded.get());
        assertEquals(0, published.get());
    }

    @Test
    void theSessionWindowStillWinsAndNobodyIsAsked() {
        AtomicInteger loaded = new AtomicInteger();
        AtomicInteger published = new AtomicInteger();

        Derived derived = CompactionThreshold.derive(
                null, counted(loaded, 0), counted(published, 1_048_576),
                "glm-5.3:cloud", 400_000);

        assertEquals(new Derived(280_000, Source.WINDOW_OVERRIDE, 400_000), derived);
        assertEquals(0, loaded.get());
        assertEquals(0, published.get());
    }

    @Test
    void theBackendIsAskedForThePublishedWindowOnceWhenItDecides() {
        AtomicInteger loaded = new AtomicInteger();
        AtomicInteger published = new AtomicInteger();

        CompactionThreshold.derive(
                null, counted(loaded, 0), counted(published, 512_000), "minimax-m3:cloud", 0);

        assertEquals(1, loaded.get());
        assertEquals(1, published.get());
    }

    @Test
    void nothingPublishedFallsToTheTableAndThenToTheConstant() {
        assertEquals(new Derived(700_000, Source.MODEL, 1_000_000),
                CompactionThreshold.derive(null, () -> 0, () -> 0, "claude-opus-4-6", 0));
        assertEquals(new Derived(CompactionThreshold.FALLBACK_THRESHOLD, Source.FALLBACK, 0),
                CompactionThreshold.derive(null, () -> 0, () -> 0, "glm-5.3:cloud", 0));
        assertEquals(new Derived(CompactionThreshold.FALLBACK_THRESHOLD, Source.FALLBACK, 0),
                CompactionThreshold.derive(null, () -> 0, () -> -1, "glm-5.3:cloud", 0),
                "a negative figure is not knowledge");
    }

    @Test
    void withNothingPublishedTheFiveArgumentFormDecidesAsTheFourArgumentOne() {
        Integer[] thresholds = {null, 0, 50_000};
        int[] windows = {0, 8_192, 204_288};
        String[] models = {null, "glm-5.3:cloud", "claude-opus-4-6"};
        int[] sessionWindows = {0, 512_000};
        for (Integer threshold : thresholds) {
            for (int window : windows) {
                for (String model : models) {
                    for (int session : sessionWindows) {
                        assertEquals(
                                CompactionThreshold.derive(threshold, () -> window, model, session),
                                CompactionThreshold.derive(threshold, () -> window, () -> 0, model, session),
                                threshold + "/" + window + "/" + model + "/" + session);
                    }
                }
            }
        }
    }

    @Test
    void aSmallPublishedWindowSizesTheSummarizersBudget() {
        Derived derived = CompactionThreshold.derive(null, () -> 0, () -> 8_192, "tiny:cloud", 0);

        assertEquals(new Derived(5_734, Source.MODEL, 8_192), derived);
        assertEquals(2_458, CompactionThreshold.summaryBudget(derived));
    }
}
