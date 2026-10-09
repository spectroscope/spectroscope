package dev.spectroscope.core.session;

/**
 * Card 492: the concept's two paragraph texts, typed from
 * {@code konzept/RUN-PROFILES.md} (Care paragraph) so the tests hold the
 * class under test to them instead of to itself.
 */
public final class CareTexts {

    /** The concept's text for two helpers, 368 characters. */
    public static final String TWO_HELPERS = "This chat runs on a local model with limited capacity, so every "
            + "request takes time. Work in small steps. Read only the file you need next, and read large "
            + "files in parts with offset and limit. Do not list or search the whole workspace in one call. "
            + "Start at most 2 subagents at once; more wait for a free slot. Check each result before the "
            + "next step. Keep answers short.";

    /** The concept's text without the subagent sentence, 306 characters. */
    public static final String NO_SUBAGENTS = "This chat runs on a local model with limited capacity, so every "
            + "request takes time. Work in small steps. Read only the file you need next, and read large "
            + "files in parts with offset and limit. Do not list or search the whole workspace in one call. "
            + "Check each result before the next step. Keep answers short.";

    private CareTexts() {
    }
}
