package dev.spectroscope.core.scheduler;

import java.util.function.Consumer;

/**
 * Where a finished job is announced (card 476). {@link HeadlessRunner#runJob}
 * hands the title and the message to the notifier it was built with, after
 * the {@code desktopNotifications} key has had its say.
 *
 * <p>Two notifiers ship. {@link #system()} is the desktop: {@code osascript} on
 * macOS, a terminal bell plus a log line elsewhere; the public
 * {@code HeadlessRunner} constructor, which {@code spectro cron} uses, holds
 * it. {@link #logOnly()} writes one line to the run's log and nothing else; it
 * is the default of the provider-override constructor that tests use, so a
 * test that forgets to inject a notifier cannot put a banner on anybody's
 * screen.</p>
 */
@FunctionalInterface
public interface DesktopNotifier {

    /**
     * Announces one finished job. Never throws: a failed notification must not
     * fail the run.
     *
     * @param title   the headline, the job id plus its status
     * @param message the body, the result preview or the stop reason
     * @param log     the run's log sink, for a fallback line or a failure note
     */
    void show(String title, String message, Consumer<String> log);

    /**
     * The desktop: a notification banner through {@code osascript} on macOS, a
     * terminal bell plus a {@code [NOTIFY]} log line on other systems.
     *
     * @return the shared system notifier
     */
    static DesktopNotifier system() {
        return SystemNotifier.INSTANCE;
    }

    /**
     * A notifier that writes {@code [NOTIFY] title: message} to the run's log
     * and shows nothing.
     *
     * @return the shared log-only notifier
     */
    static DesktopNotifier logOnly() {
        return LogOnlyNotifier.INSTANCE;
    }
}
