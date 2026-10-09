package dev.spectroscope.core.scheduler;

import java.io.IOException;
import java.util.function.Consumer;

/**
 * The desktop notifier: {@code osascript -e 'display notification'} on macOS,
 * otherwise a terminal bell plus a log line. Moved here from
 * {@code HeadlessRunner.notify} by card 476 so the runner can be handed
 * another one.
 *
 * <p>The core speaks only events, so this class never prints application
 * output; the sole exception is the deliberate terminal bell on non-macOS
 * systems.</p>
 */
final class SystemNotifier implements DesktopNotifier {

    /** The one instance {@link DesktopNotifier#system()} returns. */
    static final SystemNotifier INSTANCE = new SystemNotifier();

    private SystemNotifier() {
    }

    @Override
    public void show(String title, String message, Consumer<String> log) {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("mac")) {
            // Neutralize quotes and backslashes, or the AppleScript breaks.
            String safeTitle = sanitize(title);
            String safeMessage = sanitize(message);
            try {
                new ProcessBuilder("osascript", "-e",
                        "display notification \"" + safeMessage + "\" with title \"" + safeTitle + "\"")
                        .start(); // fire and forget: do not block the run on the banner
            } catch (IOException failure) {
                log.accept("Notification failed: " + failure.getMessage());
            }
        } else {
            System.out.print("\007"); // terminal bell, a deliberate notification concern
            log.accept("[NOTIFY] " + title + ": " + message);
        }
    }

    /**
     * Strips quotes and backslashes (the AppleScript breakers) and caps the length.
     *
     * @param text the raw notification text
     * @return a string safe to inline into the osascript command
     */
    static String sanitize(String text) {
        String cleaned = text.replaceAll("[\"\\\\]", " ");
        return cleaned.length() > 200 ? cleaned.substring(0, 200) : cleaned;
    }
}
