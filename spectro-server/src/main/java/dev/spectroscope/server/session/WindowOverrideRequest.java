package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.Locale;

/**
 * What a {@code set_window_override} frame asks for, checked (card 390).
 *
 * <p>The server decides what a person may set as the window of a session; the
 * web mirrors the two numbers below and disables its button outside them, and
 * {@code spectro-web/src/wire/windowOverride.drift.test.ts} reads them from
 * this file. A value arrives as the frame's {@code tokens} node, untrusted:</p>
 *
 * <ul>
 *   <li>absent or JSON null: a clear;</li>
 *   <li>an integral JSON number from {@link #FLOOR} to {@link #CEILING}: a set;</li>
 *   <li>anything else (a fraction, a string, a number outside the range, one
 *       too large for a long): refused, with a sentence that names the value
 *       and the range.</li>
 * </ul>
 */
final class WindowOverrideRequest {

    /** The smallest window a person may set, in tokens (card 390, owner call 5,
     *  default taken). A window this small compacts at 5,600 and leaves the
     *  summarizer a 2,400-token reserve. */
    static final int FLOOR = 8_000;

    /** The largest window a person may set, in tokens (card 390, owner call 5,
     *  default taken). The largest window reported on the owner's backends was
     *  1,048,576 (Ollama {@code /api/show} for glm-5.3:cloud, 2026-09-24); the
     *  ceiling leaves room above that and stops a typo with extra zeros. */
    static final int CEILING = 10_000_000;

    /** How much of a refused value the message repeats. */
    private static final int SHOWN = 40;

    /** What the frame asks for. */
    sealed interface Parsed permits Set, Clear, Refused {
    }

    /** Set this window.
     *  @param tokens the window in tokens, inside the range */
    record Set(int tokens) implements Parsed {
    }

    /** Remove the window; the automatic sources decide again. */
    record Clear() implements Parsed {
    }

    /** Refuse the frame and say why.
     *  @param message the sentence the operator reads, naming the value and the range */
    record Refused(String message) implements Parsed {
    }

    private WindowOverrideRequest() {
    }

    /**
     * Reads the frame's {@code tokens} node.
     *
     * @param tokens the node as it arrived; a missing node and JSON null clear
     * @return a set, a clear, or a refusal with its sentence
     */
    static Parsed parse(JsonNode tokens) {
        if (tokens == null || tokens.isMissingNode() || tokens.isNull()) {
            return new Clear();
        }
        String shown = shown(tokens);
        if (!tokens.isIntegralNumber()) {
            return new Refused("The window for this session was not set: " + shown
                    + " is not a whole number of tokens. Allowed: " + range() + ".");
        }
        if (!tokens.canConvertToLong() || !inRange(tokens.longValue())) {
            return new Refused("The window for this session was not set: " + shown
                    + " tokens is outside the allowed range of " + range() + ".");
        }
        return new Set((int) tokens.longValue());
    }

    /**
     * Whether a window may be set. The resume path asks the same question of a
     * value it reads from a session file, which a person can edit by hand.
     *
     * @param tokens the window in tokens
     * @return true from {@link #FLOOR} to {@link #CEILING}, both included
     */
    static boolean inRange(long tokens) {
        return tokens >= FLOOR && tokens <= CEILING;
    }

    /** @return the range as the messages print it */
    private static String range() {
        return String.format(Locale.ROOT, "%,d to %,d tokens", FLOOR, CEILING);
    }

    /**
     * The value as the operator sent it, cut to {@link #SHOWN} characters.
     *
     * @param tokens the node as it arrived
     * @return its JSON text, shortened with an ellipsis when longer
     */
    private static String shown(JsonNode tokens) {
        String text = tokens.toString();
        return text.length() <= SHOWN ? text : text.substring(0, SHOWN) + "...";
    }
}
