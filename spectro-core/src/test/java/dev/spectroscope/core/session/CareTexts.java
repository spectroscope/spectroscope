package dev.spectroscope.core.session;

/**
 * Card 492: the paragraph texts the tests hold the class under test to,
 * typed here instead of read from that class.
 *
 * <p>The concept's two texts ({@code konzept/RUN-PROFILES.md}, Care
 * paragraph) open with "This chat runs on a local model". The key also
 * reaches a chat on a hosted backend (card 493 turns it on for any chat, and
 * the concept gives an Anthropic chat the same numbers), where that clause is
 * false. The shipped text therefore drops "on a local model" and keeps every
 * other word of the concept.</p>
 */
public final class CareTexts {

    /** The concept's text for two helpers, 368 characters, typed from the concept. */
    public static final String CONCEPT_TWO_HELPERS = "This chat runs on a local model with limited capacity, so every "
            + "request takes time. Work in small steps. Read only the file you need next, and read large "
            + "files in parts with offset and limit. Do not list or search the whole workspace in one call. "
            + "Start at most 2 subagents at once; more wait for a free slot. Check each result before the "
            + "next step. Keep answers short.";

    /** The concept's text without the subagent sentence, 306 characters. */
    public static final String CONCEPT_NO_SUBAGENTS = "This chat runs on a local model with limited capacity, so every "
            + "request takes time. Work in small steps. Read only the file you need next, and read large "
            + "files in parts with offset and limit. Do not list or search the whole workspace in one call. "
            + "Check each result before the next step. Keep answers short.";

    /** The shipped text for two helpers, 351 characters: the concept's without "on a local model". */
    public static final String TWO_HELPERS = "This chat runs with limited capacity, so every "
            + "request takes time. Work in small steps. Read only the file you need next, and read large "
            + "files in parts with offset and limit. Do not list or search the whole workspace in one call. "
            + "Start at most 2 subagents at once; more wait for a free slot. Check each result before the "
            + "next step. Keep answers short.";

    /** The shipped text without the subagent sentence, 289 characters. */
    public static final String NO_SUBAGENTS = "This chat runs with limited capacity, so every "
            + "request takes time. Work in small steps. Read only the file you need next, and read large "
            + "files in parts with offset and limit. Do not list or search the whole workspace in one call. "
            + "Check each result before the next step. Keep answers short.";

    /** The shipped text for one helper, a chat at the floor of two sessions,
     *  350 characters: the noun is singular. */
    public static final String ONE_HELPER = "This chat runs with limited capacity, so every "
            + "request takes time. Work in small steps. Read only the file you need next, and read large "
            + "files in parts with offset and limit. Do not list or search the whole workspace in one call. "
            + "Start at most 1 subagent at once; more wait for a free slot. Check each result before the "
            + "next step. Keep answers short.";

    private CareTexts() {
    }
}
