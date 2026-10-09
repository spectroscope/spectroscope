package dev.spectroscope.core.scheduler;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * Card 476: the notifier every test that runs a job hands its runner. It keeps
 * what it was asked to show and shows nothing, so a test asserts on the
 * announcement instead of letting {@code osascript} put a banner on the
 * screen of whoever runs the suite.
 */
final class RecordingNotifier implements DesktopNotifier {

    /** One announcement as the runner phrased it. */
    record Shown(String title, String message) {
    }

    private final List<Shown> shown = new CopyOnWriteArrayList<>();

    @Override
    public void show(String title, String message, Consumer<String> log) {
        shown.add(new Shown(title, message));
    }

    /** @return every announcement so far, oldest first */
    List<Shown> shown() {
        return List.copyOf(shown);
    }
}
