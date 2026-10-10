package dev.spectroscope.core.playbook.run;

import java.util.List;

/** The effective permission of a step: the stricter of the session's mode and the step's value. */
public final class Permissions {

    /** Strict to wide. */
    static final List<String> ORDER = List.of("readonly", "ask", "auto", "extended");

    private Permissions() {
    }

    /**
     * @param session the session's live mode; an unknown word reads as ask
     * @param step    the step's permission; null and inherit take the session's
     * @return the stricter of the two
     * @throws IllegalArgumentException when a step names extended or an unknown word
     */
    public static String effective(String session, String step) {
        String s = ORDER.contains(session) ? session : "ask";
        if (step == null || step.isBlank() || "inherit".equals(step)) {
            return s;
        }
        if ("extended".equals(step) || !ORDER.contains(step)) {
            throw new IllegalArgumentException("a playbook step may not set permission " + step);
        }
        return ORDER.indexOf(step) < ORDER.indexOf(s) ? step : s;
    }

    /** @param mode a mode word; @return its place from strict (0) to wide (3), or -1 */
    public static int rank(String mode) {
        return ORDER.indexOf(mode);
    }
}
