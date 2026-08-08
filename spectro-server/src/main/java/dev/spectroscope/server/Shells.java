package dev.spectroscope.server;

import java.util.Locale;
import java.util.Set;

/**
 * The shell feature's switch (card 93). A terminal in the browser runs with the
 * operator's full privileges and the permission gate does not apply to it — the
 * operator types, not the agent — so there has to be a way to take the endpoint
 * away entirely rather than merely hide the pane: {@code SPECTRO_SHELL=off}, or
 * {@code -Dspectro.shell=off}. With it off, {@code /ws/shell} answers 404 like it
 * was never built, which is also what a non-local caller sees.
 *
 * <p>An unset value keeps the feature on. That is deliberate and it is the one
 * place here that does not err closed: a value nobody set is not a refusal, and
 * defaulting off would mean the pane ships dead.</p>
 *
 * <p>Public since card 186: WebSocketConfig in .web and SessionsController in .session both ask whether the shell is on.</p>
 */
public final class Shells {

    /** Everything read as a no. */
    private static final Set<String> NO = Set.of("off", "false", "0", "no", "disabled");

    private Shells() {
    }

    /**
     * The live setting: the system property wins over the environment, so a
     * launcher can override a shell profile.
     *
     * @return whether the shell endpoint exists in this process
     */
    public static boolean enabled() {
        String property = System.getProperty("spectro.shell");
        if (property != null && !property.isBlank()) {
            return enabled(property);
        }
        return enabled(System.getenv("SPECTRO_SHELL"));
    }

    /**
     * The rule, pure.
     *
     * @param value the raw configured value, possibly null or blank
     * @return false only for an explicit no
     */
    static boolean enabled(String value) {
        if (value == null || value.isBlank()) {
            return true;
        }
        return !NO.contains(value.strip().toLowerCase(Locale.ROOT));
    }
}
