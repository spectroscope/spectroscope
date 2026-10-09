package dev.spectroscope.core.scheduler;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 476: the desktop notification at the end of a job goes through a
 * notifier the runner is handed, and the {@code desktopNotifications} key can
 * switch it off.
 *
 * <p>Before this card {@code runJob} called a static method that started
 * {@code osascript} on every Mac, with no setting in front of it. The suite runs
 * real jobs, so every run of the core tests put "spectroscope: card-364-reach
 * failed" on the owner's screen (owner report of 2026-10-09).</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class HeadlessRunnerNotifierTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** A config built through an old positional arity: the compat path must
     *  arrive at the shipped {@code on}, or every caller that predates the key
     *  would have muted itself. */
    private static final SpectroConfig CONFIG = new SpectroConfig(
            "anthropic", "claude-opus-4-8", "http://localhost:11434", 100_000, "ask",
            List.of(), "gemini", false, List.of(), 2, true,
            List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
            null, false, false);

    private static LlmProvider answers(String text) {
        return request -> List.of(
                new LlmProvider.PTextDelta(text),
                new LlmProvider.PUsage(10, 4),
                new LlmProvider.PStop(LlmProvider.PStop.StopReason.END_TURN));
    }

    @Test
    void aFinishedJobIsAnnouncedThroughTheInjectedNotifier(@TempDir Path cwd) {
        RecordingNotifier notes = new RecordingNotifier();
        Job job = new Job("notify-476-ok", "* * * * *", "say done", cwd.toString(), Job.READONLY);

        JobState state = new HeadlessRunner(JSON, CONFIG, answers("done"))
                .withNotifier(notes)
                .runJob(job, line -> { });

        assertEquals(JobState.OK, state.status());
        assertEquals(List.of(new RecordingNotifier.Shown("spectroscope: notify-476-ok ok", "done")),
                notes.shown(),
                "the end of a job must reach the notifier the runner was handed");
    }

    @Test
    void aMissingWorkingDirectoryIsAnnouncedThroughTheInjectedNotifier() {
        RecordingNotifier notes = new RecordingNotifier();
        Job job = new Job("notify-476-gone", "* * * * *", "do it", "/definitely/not/here", null);

        new HeadlessRunner(JSON, CONFIG, answers("never"))
                .withNotifier(notes)
                .runJob(job, line -> { });

        assertEquals(1, notes.shown().size(), "the early exit announces too: " + notes.shown());
        assertEquals("spectroscope: notify-476-gone failed", notes.shown().get(0).title());
        assertTrue(notes.shown().get(0).message().contains("does not exist"),
                notes.shown().get(0).message());
    }

    @Test
    void desktopNotificationsOffMutesTheNotifier(@TempDir Path cwd) {
        RecordingNotifier notes = new RecordingNotifier();
        List<String> log = new ArrayList<>();
        SpectroConfig off = CONFIG.withDesktopNotifications(SpectroConfig.DESKTOP_NOTIFICATIONS_OFF);
        Job job = new Job("notify-476-off", "* * * * *", "say done", cwd.toString(), Job.READONLY);

        JobState state = new HeadlessRunner(JSON, off, answers("done"))
                .withNotifier(notes)
                .runJob(job, log::add);

        assertEquals(JobState.OK, state.status(), "the run itself is untouched by the switch");
        assertEquals(List.of(), notes.shown(), "desktopNotifications off must show nothing");
        assertTrue(log.stream().anyMatch(line -> line.contains("desktopNotifications")
                        && line.contains("notify-476-off")),
                "the run log says what was not shown and which key muted it: " + log);
    }

    @Test
    void desktopNotificationsOffMutesTheEarlyExitToo() {
        RecordingNotifier notes = new RecordingNotifier();
        SpectroConfig off = CONFIG.withDesktopNotifications(SpectroConfig.DESKTOP_NOTIFICATIONS_OFF);
        Job job = new Job("notify-476-gone-off", "* * * * *", "do it", "/definitely/not/here", null);

        new HeadlessRunner(JSON, off, answers("never")).withNotifier(notes).runJob(job, line -> { });

        assertEquals(List.of(), notes.shown(), "the missing-cwd path is muted as well");
    }

    @Test
    void theProductionConstructorShowsOnTheDesktop() {
        assertSame(DesktopNotifier.system(),
                new HeadlessRunner(JSON, CONFIG).notifier(),
                "spectro cron builds its runner with this constructor; it must still notify");
    }

    @Test
    void theTestSeamNeverDefaultsToTheDesktop() {
        HeadlessRunner seam = new HeadlessRunner(JSON, CONFIG, answers("x"));
        assertNotSame(DesktopNotifier.system(), seam.notifier(),
                "the provider-override constructor is the test seam; a test that forgets"
                        + " to inject must not reach osascript");
        assertSame(DesktopNotifier.logOnly(), seam.notifier());
    }

    @Test
    void everyCopyKeepsTheNotifier() {
        RecordingNotifier notes = new RecordingNotifier();
        HeadlessRunner runner = new HeadlessRunner(JSON, CONFIG, answers("x"))
                .withNotifier(notes);
        for (HeadlessRunner copy : List.of(runner.withIdentity("node-a"),
                runner.withAuxiliaryPort(event -> { }),
                runner.withCancelSignal(new dev.spectroscope.core.CancelSignal()),
                runner.withBroker(request -> false), runner.withOutsideReach(true),
                runner.withTrigger("t"), runner.withMcp(Boolean.FALSE),
                runner.withMcpLoader((servers, dir) -> null))) {
            assertSame(notes, copy.notifier(), "a with-copy dropped the injected notifier");
        }
    }

    @Test
    void theLogOnlyNotifierWritesOneLineToTheRunLog() {
        List<String> log = new ArrayList<>();
        DesktopNotifier.logOnly().show("spectroscope: j failed", "max_turns", log::add);
        assertEquals(List.of("[NOTIFY] spectroscope: j failed: max_turns"), log);
    }
}
