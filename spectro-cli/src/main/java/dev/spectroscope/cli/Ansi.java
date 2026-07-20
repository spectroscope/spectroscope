package dev.spectroscope.cli;

/**
 * Minimal ANSI styling for the terminal renderer, tuned to the house
 * palette (Coral for interaction/accents, Sand for editorial highlights).
 *
 * <p>Styling silently degrades to plain text when stdout is not a real terminal,
 * when {@code NO_COLOR} is set, or when {@code TERM=dumb} — piped output and CI
 * logs stay free of escape codes.</p>
 */
final class Ansi {

    private final boolean enabled;

    /**
     * Instances come only from {@link #detect()} or {@link #forced(boolean)}.
     *
     * @param enabled whether escape codes are emitted at all — false turns every
     *                styling call into a pass-through
     */
    private Ansi(boolean enabled) {
        this.enabled = enabled;
    }

    /**
     * Detects TTY/NO_COLOR/TERM once at startup.
     *
     * @return a styling instance — active only when stdout is a real terminal and
     *         neither {@code NO_COLOR} nor {@code TERM=dumb} opts out
     */
    static Ansi detect() {
        boolean isTty = System.console() != null;
        boolean noColor = System.getenv("NO_COLOR") != null;
        boolean dumbTerm = "dumb".equals(System.getenv("TERM"));
        return new Ansi(isTty && !noColor && !dumbTerm);
    }

    /**
     * Test/CI hook: force plain or styled output regardless of the terminal.
     *
     * @param enabled true forces escape codes even without a TTY, false forces plain text
     * @return an instance with the detection result overridden
     */
    static Ansi forced(boolean enabled) {
        return new Ansi(enabled);
    }

    /**
     * Whether styling is active — consumers like the {@link Spinner} skip their
     * animation entirely when it is not.
     *
     * @return true when escape codes are emitted, false in plain-text mode
     */
    boolean enabled() {
        return enabled;
    }

    /**
     * The one place escape codes are assembled: SGR on, text, reset — or the text
     * untouched when styling is off.
     *
     * @param code the SGR parameter(s), e.g. {@code "1"} for bold or {@code "38;5;203"} for coral
     * @param text the content to style
     * @return the wrapped string, or {@code text} unchanged in plain-text mode
     */
    private String wrap(String code, String text) {
        return enabled ? "\u001B[" + code + "m" + text + "\u001B[0m" : text;
    }

    /**
     * Bold — headers, tool names, session ids.
     *
     * @param text the content to emphasize
     * @return the styled string, or {@code text} unchanged in plain-text mode
     */
    String bold(String text)  { return wrap("1", text); }

    /**
     * Dim — secondary detail such as previews, hints and the thinking stream.
     *
     * @param text the content to de-emphasize
     * @return the styled string, or {@code text} unchanged in plain-text mode
     */
    String dim(String text)   { return wrap("2", text); }

    /**
     * Coral #FF5959 — interactive elements and accents only (brand rule).
     *
     * @param text the content to accent
     * @return the styled string, or {@code text} unchanged in plain-text mode
     */
    String coral(String text) { return wrap("38;5;203", text); }

    /**
     * Sand #FFEF7A — editorial highlight on dark ground (permission prompts).
     *
     * @param text the content to highlight
     * @return the styled string, or {@code text} unchanged in plain-text mode
     */
    String sand(String text)  { return wrap("38;5;228", text); }

    /**
     * Green — success marks and healthy doctor lines.
     *
     * @param text the content to mark as good
     * @return the styled string, or {@code text} unchanged in plain-text mode
     */
    String green(String text) { return wrap("38;5;114", text); }

    /**
     * Red — error marks, denials and failed checks.
     *
     * @param text the content to mark as failed
     * @return the styled string, or {@code text} unchanged in plain-text mode
     */
    String red(String text)   { return wrap("38;5;167", text); }

    /**
     * Carriage return plus erase-line — used to wipe the spinner frame.
     *
     * @return the control sequence, or an empty string in plain-text mode (nothing to wipe)
     */
    String clearLine() {
        return enabled ? "\r\u001B[2K" : "";
    }
}
