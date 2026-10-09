package dev.spectroscope.core.scheduler;

import java.util.function.Consumer;

/** The notifier behind {@link DesktopNotifier#logOnly()}: one log line, no banner. */
enum LogOnlyNotifier implements DesktopNotifier {
    /** The one instance. */
    INSTANCE;

    @Override
    public void show(String title, String message, Consumer<String> log) {
        log.accept("[NOTIFY] " + title + ": " + message);
    }
}
