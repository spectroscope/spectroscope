package dev.spectroscope.server;

import java.util.Locale;

/**
 * Where a recording goes to be turned into text.
 *
 * <p>Two paths, chosen the way the chat providers are (card 187, the
 * correction). They are not ranked: the hosted one works on a machine with
 * nothing installed, which is the majority of the people a DMG exists for; the
 * local one sends nothing out, which is the axis this product differentiates
 * on.</p>
 */
public enum SttRoute {

    /** whisper.cpp as a child process — keyless, offline, private. */
    LOCAL,

    /** A hosted transcription API — no binary, no model, no setup. */
    HOSTED;

    /** The settings value that means "decide by what this machine has". */
    public static final String AUTO = "auto";

    /**
     * The route a call takes.
     *
     * <p>An explicit choice wins even when it cannot run right now: the caller
     * then reports what is missing, which is more use than being silently
     * rerouted — and in this direction silence would also mean audio leaving a
     * machine whose owner asked for the local path.</p>
     *
     * @param configured the {@code sttProvider} setting; blank or unknown reads
     *                   as {@link #AUTO}
     * @param keyPresent whether the hosted provider's key is set somewhere
     * @return the path to take
     */
    public static SttRoute of(String configured, boolean keyPresent) {
        String value = configured == null ? "" : configured.strip().toLowerCase(Locale.ROOT);
        if (value.equals("local")) {
            return LOCAL;
        }
        if (value.equals("openai")) {
            return HOSTED;
        }
        // auto, and anything unrecognised: the hosted path only when it can
        // actually run. A machine with whisper installed and no key was working
        // before this card and must not stop working because of it.
        return keyPresent ? HOSTED : LOCAL;
    }
}
