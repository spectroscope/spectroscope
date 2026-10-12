package dev.spectroscope.core.loop;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 504, criteria 6 to 9 and the core half of 11: the loop of one session
 * on a hand-moved clock. The driver arms wakeups on the whole minute, fires
 * them only into an attached, idle session, expands the sentinel, keeps one
 * keepalive and ends for the three reasons, each written to
 * {@code .loop.jsonl}.
 */
class LoopDriverTest {

    /** 10:00:20 local time on a fixed day, so the whole minute is visible. */
    private static final long T0 = LocalDateTime.of(2026, 10, 11, 10, 0, 20)
            .atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
    private static final long MINUTE = 60_000L;

    /** The session as the driver sees it. */
    static final class Host implements LoopDriver.Host {
        boolean attached = true;
        boolean idle = true;
        final List<String[]> runs = new ArrayList<>();
        final List<LoopState> infos = new ArrayList<>();

        @Override
        public boolean attached() {
            return attached;
        }

        @Override
        public boolean idle() {
            return idle;
        }

        /** Starts the driver asked for while the session was busy; the driver must not ask. */
        int askedWhileBusy;

        @Override
        public boolean startRun(String record, String model) {
            if (!idle) {
                askedWhileBusy++;
                return false;
            }
            idle = false;
            runs.add(new String[] {record, model});
            return true;
        }

        @Override
        public void info(LoopState state) {
            infos.add(state);
        }

        String lastModel() {
            return runs.get(runs.size() - 1)[1];
        }

        LoopState last() {
            return infos.get(infos.size() - 1);
        }
    }

    private static final class Rig {
        final FakeTimer timer = new FakeTimer(T0);
        final Host host = new Host();
        final LoopSidecar sidecar;
        final LoopDriver driver;

        Rig(Path dir) {
            sidecar = new LoopSidecar(dir);
            driver = new LoopDriver("s-504", timer, timer, sidecar);
            driver.host(host);
        }

        /** The operator's /loop: the command's own run starts with it. */
        LoopDriver.Start start(String prompt, Integer intervalSeconds) {
            host.idle = false;
            return driver.start(prompt, intervalSeconds);
        }

        /** The run the host started ends; the session is idle again. */
        void runEnds() {
            host.idle = true;
            driver.runEnded();
        }

        List<String> lineTypes() {
            return sidecar.read("s-504").stream().map(line -> line.path("type").asText()).toList();
        }

        JsonNode lastLine(String type) {
            JsonNode found = null;
            for (JsonNode line : sidecar.read("s-504")) {
                if (type.equals(line.path("type").asText())) {
                    found = line;
                }
            }
            return found;
        }
    }

    private static long wholeMinuteAtOrAfter(long at) {
        return ((at + MINUTE - 1) / MINUTE) * MINUTE;
    }

    // ── criterion 6: /loop with an interval ──────────────────────────────

    @Test
    void aFixedIntervalRunsNowArmsOnTheWholeMinuteAndRepeats(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        LoopDriver.Start start = rig.start("check the CI", 120);
        assertTrue(start.modelText().startsWith("check the CI"), start.modelText());
        assertTrue(start.modelText().contains("starts the next run by itself"), start.modelText());
        assertFalse(start.modelText().contains(LoopPrompts.SENTINEL), "a fixed loop is armed by the harness");
        long first = wholeMinuteAtOrAfter(T0 + 120_000);
        assertEquals(first, rig.host.last().nextAt());
        assertEquals("fixed", rig.host.last().pacing());
        rig.runEnds();

        rig.timer.advanceTo(first - 1);
        assertTrue(rig.host.runs.isEmpty(), "nothing before its minute");
        rig.timer.advanceTo(first);
        assertEquals(1, rig.host.runs.size(), "the first wakeup fired");
        assertEquals("check the CI", rig.host.runs.get(0)[0]);
        long second = wholeMinuteAtOrAfter(first + 120_000);
        assertEquals(second, rig.host.last().nextAt(), "re-armed from the fire");
        rig.runEnds();
        rig.timer.advanceTo(second);
        assertEquals(2, rig.host.runs.size(), "and it repeats");
        assertEquals(2, rig.driver.state().fires());
        assertTrue(rig.driver.state().active());
    }

    @Test
    void aFixedLoopKeepsItsCadenceWhenAFireComesLate(@TempDir Path dir) {
        // Live check 2026-10-12: a /loop 2m fired every three minutes, because
        // each fire landed a few ms after its minute and the next wakeup was
        // rounded up from there.
        Rig rig = new Rig(dir);
        rig.start("check", 120);
        long first = rig.host.last().nextAt();
        rig.timer.advanceTo(first); // still busy: held
        assertTrue(rig.driver.state().held());
        rig.timer.advanceTo(first + 12);
        rig.runEnds(); // fires 12 ms late
        assertEquals(1, rig.host.runs.size());
        assertEquals(first + 120_000, rig.driver.state().nextAt(), "the cadence counts from the minute it was due");
    }

    @Test
    void aFixedLoopFiredLaterThanItsNextMinuteStartsAFreshCadence(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("check", 120);
        long first = rig.host.last().nextAt();
        rig.timer.advanceTo(first + 300_000); // held for five minutes
        rig.runEnds();
        long fired = first + 300_000;
        assertEquals(wholeMinuteAtOrAfter(fired + 120_000), rig.driver.state().nextAt(), "never in the past");
    }

    @Test
    void aFixedIntervalIsClampedToTheSameRange(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("check", 5);
        assertEquals(wholeMinuteAtOrAfter(T0 + 60_000), rig.host.last().nextAt());
        assertEquals(60, rig.driver.state().intervalSeconds());
        Rig other = new Rig(dir.resolve("b"));
        other.start("check", 86_400);
        assertEquals(3_600, other.driver.state().intervalSeconds());
    }

    // ── criterion 6: /loop without an interval ───────────────────────────

    @Test
    void withoutAnIntervalTheModelIsToldToSelfPace(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        LoopDriver.Start start = rig.start("watch the build", null);
        assertTrue(start.modelText().startsWith("watch the build"), start.modelText());
        assertTrue(start.modelText().contains("schedule_wakeup"), start.modelText());
        assertTrue(start.modelText().contains(LoopPrompts.SENTINEL), start.modelText());
        assertTrue(start.modelText().contains("last call of the turn"), start.modelText());
        assertNull(rig.host.last().nextAt(), "nothing is armed until the model calls schedule_wakeup");
        assertEquals("self", rig.host.last().pacing());
    }

    // ── criterion 7: schedule_wakeup ─────────────────────────────────────

    @Test
    void aDelayIsClampedTo60And3600AndSaysSo(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        LoopDriver.Scheduled low = rig.driver.schedule(10.0, "soon", LoopPrompts.SENTINEL, false);
        assertEquals(60, low.delaySeconds());
        assertTrue(low.wasClamped());
        LoopDriver.Scheduled high = rig.driver.schedule(99_999.0, "later", LoopPrompts.SENTINEL, false);
        assertEquals(3_600, high.delaySeconds());
        assertTrue(high.wasClamped());
        LoopDriver.Scheduled fine = rig.driver.schedule(300.0, "five minutes", LoopPrompts.SENTINEL, false);
        assertEquals(300, fine.delaySeconds());
        assertFalse(fine.wasClamped());
        assertTrue(fine.text().contains("(in "), fine.text());
        assertTrue(fine.text().contains("Write the per tick update before this call; the turn ends when it returns."),
                fine.text());
        assertTrue(high.text().contains("clamped to 3600 s"), high.text());
    }

    @Test
    void aWakeupLandsOnTheWholeMinuteAtOrAfterTheDelay(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        LoopDriver.Scheduled s = rig.driver.schedule(90.0, "ninety", LoopPrompts.SENTINEL, false);
        long requested = T0 + 90_000;
        assertEquals(wholeMinuteAtOrAfter(requested), s.scheduledFor());
        long drift = s.scheduledFor() - requested;
        assertTrue(drift >= 0 && drift < MINUTE, "drift " + drift);
        String clock = java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss")
                .format(java.time.Instant.ofEpochMilli(s.scheduledFor()).atZone(ZoneId.systemDefault()));
        assertTrue(s.text().startsWith("Next wakeup at " + clock), s.text());
    }

    @Test
    void reasonPromptAndDelayAreRequiredUnlessStop(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        for (LoopDriver.Scheduled refused : List.of(
                rig.driver.schedule(null, "r", LoopPrompts.SENTINEL, false),
                rig.driver.schedule(120.0, null, LoopPrompts.SENTINEL, false),
                rig.driver.schedule(120.0, " ", LoopPrompts.SENTINEL, false),
                rig.driver.schedule(120.0, "r", null, false))) {
            assertFalse(refused.ok());
            assertTrue(refused.text().startsWith("ERROR:"), refused.text());
        }
        assertNull(rig.driver.state().nextAt(), "nothing was armed");
        assertTrue(rig.driver.schedule(null, null, null, true).ok(), "stop needs nothing else");
    }

    @Test
    void aNewWakeupCancelsThePendingOneOfTheLoop(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.driver.schedule(120.0, "first", LoopPrompts.SENTINEL, false);
        LoopDriver.Scheduled second = rig.driver.schedule(600.0, "second", LoopPrompts.SENTINEL, false);
        assertEquals(1, rig.timer.cancelled(), "the first was cancelled");
        assertEquals(1, rig.timer.live());
        rig.runEnds();
        rig.timer.advanceTo(T0 + 3 * MINUTE);
        assertTrue(rig.host.runs.isEmpty(), "the cancelled wakeup does not fire");
        rig.timer.advanceTo(second.scheduledFor());
        assertEquals(1, rig.host.runs.size());
        assertEquals("second", rig.lastLine("loop_fire").path("reason").asText());
    }

    // ── criterion 8: idle only, loop_fire, the sentinel ─────────────────

    @Test
    void aWakeupFiresOnlyWhenTheSessionIsIdle(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        LoopDriver.Scheduled s = rig.driver.schedule(120.0, "check", LoopPrompts.SENTINEL, false);
        // The first run is still going (the operator typed something).
        rig.timer.advanceTo(s.scheduledFor());
        assertTrue(rig.host.runs.isEmpty(), "no run while one is in flight");
        assertEquals(0, rig.host.askedWhileBusy, "the driver itself holds a wakeup while the session is busy");
        assertTrue(rig.driver.state().held());
        rig.runEnds();
        assertEquals(1, rig.host.runs.size(), "it fires when the session is idle again");
        assertFalse(rig.driver.state().held());
        JsonNode fire = rig.lastLine("loop_fire");
        assertNotNull(fire);
        assertEquals("check", fire.path("reason").asText());
        assertTrue(fire.path("driftMs").asLong() >= 0);
    }

    @Test
    void theSentinelExpandsToTheFullInstructionsFirstAndAfterACompactionAndToAReminderOtherwise(
            @TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch the build", null);
        // first fire: the full instructions
        LoopDriver.Scheduled s1 = rig.driver.schedule(60.0, "one", LoopPrompts.SENTINEL, false);
        rig.runEnds();
        rig.timer.advanceTo(s1.scheduledFor());
        String first = rig.host.lastModel();
        assertTrue(first.startsWith(LoopPrompts.FULL_HEADING), first);
        assertTrue(first.contains("watch the build"), "the full text carries the task: " + first);
        assertEquals("watch the build", rig.host.runs.get(0)[0], "the record names the loop's task");
        // second fire: the reminder
        LoopDriver.Scheduled s2 = rig.driver.schedule(60.0, "two", LoopPrompts.SENTINEL, false);
        rig.runEnds();
        rig.timer.advanceTo(s2.scheduledFor());
        String second = rig.host.lastModel();
        assertTrue(second.startsWith(LoopPrompts.REMINDER_HEADING), second);
        assertFalse(second.contains("watch the build"), "the reminder is short: " + second);
        // after a compaction: the full instructions again
        LoopDriver.Scheduled s3 = rig.driver.schedule(60.0, "three", LoopPrompts.SENTINEL, false);
        rig.runEnds();
        rig.driver.compacted();
        rig.timer.advanceTo(s3.scheduledFor());
        assertTrue(rig.host.lastModel().startsWith(LoopPrompts.FULL_HEADING), rig.host.lastModel());
        assertEquals(List.of("full", "reminder", "full"), rig.sidecar.read("s-504").stream()
                .filter(l -> "loop_fire".equals(l.path("type").asText()))
                .map(l -> l.path("expansion").asText()).toList());
    }

    @Test
    void aPromptTheModelWroteFiresAttributedToTheModelInTheRecordAndInTheModelText(@TempDir Path dir) {
        // Fix round 1, replacing "fires as written": a prompt the model wrote
        // reached the record and the model as if the operator had typed it.
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        LoopDriver.Scheduled s = rig.driver.schedule(60.0, "r", "look at the log again", false);
        rig.runEnds();
        rig.timer.advanceTo(s.scheduledFor());
        String record = rig.host.runs.get(0)[0];
        assertTrue(record.startsWith(LoopPrompts.MODEL_WRITTEN_HEADING), record);
        assertTrue(record.contains("10:00:20"), "when the model wrote it: " + record);
        assertTrue(record.contains("the operator did not type it"), record);
        assertTrue(record.endsWith("look at the log again"), record);
        assertTrue(rig.host.lastModel().startsWith(record), "the model reads the same attribution: "
                + rig.host.lastModel());
        assertTrue(rig.host.lastModel().contains("schedule_wakeup"), rig.host.lastModel());
    }

    @Test
    void aFixedLoopAttributesAPromptTheModelWroteAndThenFiresTheOperatorsTaskAgain(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("check the CI", 120);
        rig.runEnds();
        LoopDriver.Scheduled s = rig.driver.schedule(60.0, "r", "deploy to production", false);
        rig.timer.advanceTo(s.scheduledFor());
        String record = rig.host.runs.get(0)[0];
        assertTrue(record.startsWith(LoopPrompts.MODEL_WRITTEN_HEADING), record);
        assertTrue(record.endsWith("deploy to production"), record);
        assertTrue(rig.host.lastModel().startsWith(record), rig.host.lastModel());
        rig.runEnds();
        rig.timer.advanceTo(rig.driver.state().nextAt());
        assertEquals("check the CI", rig.host.runs.get(1)[0], "the operator's task, as typed");
    }

    @Test
    void theSentinelAndTheOperatorsOwnTaskAreNotAttributed(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        LoopDriver.Scheduled s = rig.driver.schedule(60.0, "r", "watch", false);
        rig.runEnds();
        rig.timer.advanceTo(s.scheduledFor());
        assertEquals("watch", rig.host.runs.get(0)[0]);
        // Fix round 2, replacing the check that the armed line repeats the
        // task: a wakeup that fires the loop's own task leaves it out of the
        // line, and the loop_start line holds it once.
        assertFalse(rig.lastLine("wakeup_armed").has("prompt"), rig.lastLine("wakeup_armed").toString());
    }

    // ── fix round 2: what the model writes is bounded ───────────────────

    @Test
    void aReasonLongerThanTheCapIsCutWithAMarker(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        LoopDriver.Scheduled s = rig.driver.schedule(60.0, "r".repeat(LoopLimits.TEXT_CAP + 100),
                LoopPrompts.SENTINEL, false);
        assertTrue(s.ok(), s.text());
        String reason = rig.driver.state().reason();
        assertTrue(reason.startsWith("r".repeat(LoopLimits.TEXT_CAP) + " [cut at "), reason);
        assertFalse(reason.startsWith("r".repeat(LoopLimits.TEXT_CAP + 1)), "nothing past the cap");
        assertEquals(reason, rig.lastLine("wakeup_armed").path("reason").asText());
        LoopDriver.Scheduled atCap = rig.driver.schedule(60.0, "q".repeat(LoopLimits.TEXT_CAP),
                LoopPrompts.SENTINEL, false);
        assertEquals("q".repeat(LoopLimits.TEXT_CAP), rig.driver.state().reason(), "a reason at the cap stays whole: "
                + atCap.text());
    }

    @Test
    void aPromptTheModelWroteLongerThanTheCapIsRefused(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        LoopDriver.Scheduled refused = rig.driver.schedule(60.0, "r", "p".repeat(LoopLimits.TEXT_CAP + 1), false);
        assertFalse(refused.ok());
        assertTrue(refused.text().startsWith("ERROR:"), refused.text());
        assertTrue(refused.text().contains(String.valueOf(LoopLimits.TEXT_CAP)), refused.text());
        assertNull(rig.driver.state().nextAt(), "nothing was armed");
        assertTrue(rig.driver.schedule(60.0, "r", "p".repeat(LoopLimits.TEXT_CAP), false).ok(),
                "a prompt at the cap passes");
    }

    @Test
    void theLoopsOwnTaskAndTheSentinelPassTheCapWhateverTheTasksLength(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        String task = "t".repeat(LoopLimits.TEXT_CAP * 4);
        rig.start(task, null);
        assertTrue(rig.driver.schedule(60.0, "r", task, false).ok(), "the operator's task is not the model's text");
        assertTrue(rig.driver.schedule(60.0, "r", LoopPrompts.SENTINEL, false).ok());
    }

    // ── hub and spoke fix round (2026-10-12) ─────────────────────────────

    /** True when every surrogate in the text has its partner. */
    private static boolean wellFormed(String text) {
        return text.codePoints().noneMatch(cp -> cp >= Character.MIN_SURROGATE && cp <= Character.MAX_SURROGATE);
    }

    @Test
    void aReasonCutAtTheCapNeverSplitsASurrogatePair(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        // The emoji's two halves sit on either side of the cap.
        String before = "ä".repeat(LoopLimits.TEXT_CAP - 1);
        rig.driver.schedule(60.0, before + "😀 and more", LoopPrompts.SENTINEL, false);
        String reason = rig.driver.state().reason();
        assertTrue(wellFormed(reason), "no half of a pair: " + reason.substring(LoopLimits.TEXT_CAP - 3));
        assertTrue(reason.startsWith(before + " [cut at "), reason.substring(LoopLimits.TEXT_CAP - 3));
        assertTrue(wellFormed(rig.lastLine("wakeup_armed").path("reason").asText()), "the sidecar line too");
        // Positive: an emoji that ends exactly at the cap is kept whole.
        String whole = "ö".repeat(LoopLimits.TEXT_CAP - 2) + "😀";
        rig.driver.schedule(60.0, whole + " tail", LoopPrompts.SENTINEL, false);
        assertTrue(rig.driver.state().reason().startsWith(whole + " [cut at "), rig.driver.state().reason());
        // Non ASCII text at the cap is not cut at all.
        String umlauts = "ü".repeat(LoopLimits.TEXT_CAP);
        rig.driver.schedule(60.0, umlauts, LoopPrompts.SENTINEL, false);
        assertEquals(umlauts, rig.driver.state().reason());
    }

    @Test
    void aSentinelTheModelWroteInAFixedLoopFiresTheLoopsOwnTask(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("check the CI", 120);
        rig.runEnds();
        LoopDriver.Scheduled s = rig.driver.schedule(60.0, "r", LoopPrompts.SENTINEL, false);
        rig.timer.advanceTo(s.scheduledFor());
        assertEquals(1, rig.host.runs.size(), "the wakeup fired");
        assertEquals("check the CI", rig.host.runs.get(0)[0], "the record names the operator's task");
        assertEquals(LoopPrompts.fixed("check the CI", 120), rig.host.lastModel());
        assertFalse(rig.host.lastModel().contains(LoopPrompts.SENTINEL), rig.host.lastModel());
    }

    @Test
    void theStopResultSaysTheTurnEndsAndTheClosingSummaryComesFirst(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        LoopDriver.Scheduled stopped = rig.driver.schedule(null, null, null, true);
        assertTrue(stopped.ok());
        assertTrue(stopped.text().contains("The turn ends when this call returns"), stopped.text());
        assertTrue(stopped.text().contains("closing summary"), stopped.text());
    }

    @Test
    void everyLoopTextTellsTheModelToWriteTheClosingSummaryBeforeItStops() {
        for (String text : List.of(LoopPrompts.selfPacedStart("t"), LoopPrompts.full("t"), LoopPrompts.reminder(),
                LoopPrompts.fixed("t", 120), LoopPrompts.verbatimSelfPaced("t"))) {
            assertTrue(text.contains("closing summary"), text);
        }
    }

    @Test
    void aFixedLoopWritesItsTaskOnceAndRestoresItFromTheStartLine(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        String task = "check the CI " + "t".repeat(LoopLimits.TEXT_CAP * 4);
        rig.start(task, 120);
        rig.runEnds();
        rig.timer.advanceTo(rig.driver.state().nextAt());
        rig.runEnds();
        long armedLines = 0;
        for (JsonNode line : rig.sidecar.read("s-504")) {
            if ("wakeup_armed".equals(line.path("type").asText())) {
                armedLines++;
                assertFalse(line.has("prompt"), "the task is not repeated on every wakeup");
            }
        }
        assertEquals(2, armedLines);
        FakeTimer later = new FakeTimer(rig.timer.getAsLong());
        LoopDriver restored = LoopDriver.restore("s-504", later, later, rig.sidecar);
        Host host = new Host();
        restored.host(host);
        later.advanceTo(restored.state().nextAt());
        assertEquals(task, host.runs.get(0)[0], "the restored wakeup fires the task from loop_start");
    }

    // ── criterion 9: the bounds ─────────────────────────────────────────

    @Test
    void oneKeepaliveThenTheSecondMissEndsTheLoopAsModelStopped(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.runEnds(); // the first tick ends without schedule_wakeup
        LoopState armed = rig.driver.state();
        assertTrue(armed.active());
        assertTrue(armed.keepalive(), "the keepalive is armed");
        assertEquals(wholeMinuteAtOrAfter(T0 + LoopLimits.KEEPALIVE_SECONDS * 1_000L), armed.nextAt());
        rig.timer.advanceTo(armed.nextAt());
        assertEquals(1, rig.host.runs.size(), "the keepalive fired");
        rig.runEnds(); // the second miss
        assertFalse(rig.driver.state().active());
        assertEquals("model_stopped", rig.driver.state().endedReason());
        assertEquals("model_stopped", rig.host.last().endedReason(), "the page is told");
        assertEquals("model_stopped", rig.lastLine("loop_end").path("reason").asText());
        assertEquals(0, rig.timer.live());
    }

    @Test
    void aTickThatReschedulesResetsTheKeepalive(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.runEnds(); // miss: keepalive
        rig.timer.advanceTo(rig.driver.state().nextAt());
        rig.driver.schedule(60.0, "back on track", LoopPrompts.SENTINEL, false);
        rig.runEnds();
        assertFalse(rig.driver.state().keepalive());
        rig.timer.advanceTo(rig.driver.state().nextAt());
        rig.runEnds(); // a miss again: a fresh keepalive, not the end
        assertTrue(rig.driver.state().active());
        assertTrue(rig.driver.state().keepalive());
    }

    @Test
    void aFixedLoopNeedsNoKeepalive(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("check", 120);
        rig.runEnds();
        assertFalse(rig.driver.state().keepalive());
        assertTrue(rig.driver.state().active());
    }

    @Test
    void sevenDaysAfterItsStartTheLoopAgesOut(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.runEnds();
        rig.timer.advanceTo(T0 + LoopLimits.MAX_AGE_MS);
        LoopDriver.Scheduled late = rig.driver.schedule(60.0, "again", LoopPrompts.SENTINEL, false);
        assertFalse(late.ok());
        assertTrue(late.text().contains("age limit"), late.text());
        assertEquals("aged_out", rig.driver.state().endedReason());
        assertEquals("aged_out", rig.lastLine("loop_end").path("reason").asText());
    }

    @Test
    void aWakeupDuePastTheAgeLimitDoesNotFire(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("check", 3_600);
        rig.runEnds();
        for (int hour = 0; hour < 24 * 7 + 2; hour++) {
            rig.timer.advanceBy(3_600_000L);
            if (!rig.host.idle) {
                rig.runEnds();
            }
        }
        assertEquals("aged_out", rig.driver.state().endedReason());
        long last = rig.host.runs.size();
        assertTrue(last <= 24 * 7 + 1, "no fire after seven days: " + last);
    }

    @Test
    void stopInTheChatEndsTheLoopAsUserAbort(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.driver.schedule(120.0, "r", LoopPrompts.SENTINEL, false);
        rig.driver.userAbort();
        assertEquals("user_abort", rig.driver.state().endedReason());
        assertEquals(0, rig.timer.live(), "the pending wakeup is cancelled");
        rig.runEnds();
        rig.timer.advanceBy(10 * MINUTE);
        assertTrue(rig.host.runs.isEmpty());
        assertEquals("user_abort", rig.lastLine("loop_end").path("reason").asText());
    }

    @Test
    void scheduleWakeupWithStopEndsTheLoopAndCountsWhatItCancelled(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.driver.schedule(120.0, "r", LoopPrompts.SENTINEL, false);
        LoopDriver.Scheduled stopped = rig.driver.schedule(null, null, null, true);
        assertTrue(stopped.ok());
        assertTrue(stopped.text().startsWith("Loop stopped"), stopped.text());
        assertTrue(stopped.text().contains("1 pending wakeup"), stopped.text());
        assertEquals("model_stopped", rig.driver.state().endedReason());
        assertEquals(0, rig.timer.live());
    }

    @Test
    void anEndedLoopRefusesANewWakeup(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.driver.userAbort();
        LoopDriver.Scheduled after = rig.driver.schedule(60.0, "r", LoopPrompts.SENTINEL, false);
        assertFalse(after.ok());
        assertEquals(0, rig.timer.live());
    }

    // ── criterion 11, the core half: held while nobody is attached ──────

    @Test
    void aWakeupDueWhileNoClientIsAttachedIsHeldAndFiresOnReattach(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.runEnds();
        LoopDriver.Scheduled s = rig.driver.schedule(120.0, "r", LoopPrompts.SENTINEL, false);
        rig.driver.host(null); // the socket closed
        rig.timer.advanceTo(s.scheduledFor() + 5 * MINUTE);
        assertTrue(rig.host.runs.isEmpty(), "no run with nobody attached");
        assertTrue(rig.driver.state().held());
        assertNotNull(rig.lastLine("loop_held"), "held in .loop.jsonl");
        Host back = new Host();
        rig.driver.host(back);
        assertEquals(1, back.runs.size(), "it fires on reattach");
    }

    @Test
    void aHeldWakeupThatAgedOutDoesNotFireOnReattach(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.runEnds();
        rig.driver.schedule(3_600.0, "r", LoopPrompts.SENTINEL, false);
        rig.driver.host(null);
        rig.timer.advanceTo(T0 + LoopLimits.MAX_AGE_MS + MINUTE);
        Host back = new Host();
        rig.driver.host(back);
        assertTrue(back.runs.isEmpty());
        assertEquals("aged_out", rig.driver.state().endedReason());
    }

    @Test
    void theSidecarRestoresAPendingWakeupForAFreshDriver(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.runEnds();
        LoopDriver.Scheduled s = rig.driver.schedule(600.0, "ten minutes", LoopPrompts.SENTINEL, false);
        FakeTimer later = new FakeTimer(T0 + MINUTE);
        LoopDriver restored = LoopDriver.restore("s-504", later, later, rig.sidecar);
        assertNotNull(restored);
        assertEquals(s.scheduledFor(), restored.state().nextAt());
        assertEquals("ten minutes", restored.state().reason());
        Host host = new Host();
        restored.host(host);
        later.advanceTo(s.scheduledFor());
        assertEquals(1, host.runs.size());
        assertEquals("watch", host.runs.get(0)[0]);
    }

    @Test
    void anEndedLoopIsNotRestored(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.driver.userAbort();
        FakeTimer later = new FakeTimer(T0 + MINUTE);
        assertNull(LoopDriver.restore("s-504", later, later, rig.sidecar));
    }

    // ── fix round 1: an end nobody saw is told on the next attach ───────

    /** Ends the loop as aged_out at a wakeup that falls due while nobody is attached. */
    private static void ageOutDetached(Rig rig) {
        rig.start("watch", null);
        rig.timer.advanceTo(T0 + LoopLimits.MAX_AGE_MS - 30 * MINUTE);
        LoopDriver.Scheduled s = rig.driver.schedule(3_600.0, "r", LoopPrompts.SENTINEL, false);
        rig.runEnds();
        rig.driver.host(null);
        rig.timer.advanceTo(s.scheduledFor());
        assertEquals(LoopDriver.AGED_OUT, rig.driver.state().endedReason(), "premise: it aged out");
    }

    private static void assertToldOnceOnReattach(Rig rig, String reason) {
        Host back = new Host();
        rig.driver.host(back);
        LoopState told = back.last();
        assertFalse(told.active());
        assertEquals(reason, told.endedReason());
        assertTrue(told.endUnseen(), "the first client after the end hears that nobody saw it");
        assertNotNull(rig.lastLine("loop_end_seen"), "the sidecar records that a client heard it");
        Host third = new Host();
        rig.driver.host(third);
        assertFalse(third.last().endUnseen(), "told once, not on every attach");
    }

    @Test
    void aLoopThatAgedOutWhileNobodyWasAttachedIsToldOnReattach(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        ageOutDetached(rig);
        assertToldOnceOnReattach(rig, LoopDriver.AGED_OUT);
    }

    @Test
    void aLoopTheModelStoppedWhileNobodyWasAttachedIsToldOnReattach(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.runEnds(); // a tick without schedule_wakeup: the keepalive
        rig.timer.advanceTo(rig.driver.state().nextAt());
        assertEquals(1, rig.host.runs.size(), "premise: the keepalive fired");
        rig.driver.host(null); // the socket closed during the tick
        rig.runEnds(); // the second miss
        assertEquals(LoopDriver.MODEL_STOPPED, rig.driver.state().endedReason());
        assertToldOnceOnReattach(rig, LoopDriver.MODEL_STOPPED);
    }

    @Test
    void aLoopStoppedWhileNobodyWasAttachedIsToldOnReattach(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.driver.host(null);
        rig.driver.userAbort();
        assertToldOnceOnReattach(rig, LoopDriver.USER_ABORT);
    }

    @Test
    void anEndNobodySawSurvivesARestartAndIsToldOnce(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        ageOutDetached(rig);
        FakeTimer later = new FakeTimer(rig.timer.getAsLong() + MINUTE);
        LoopDriver restored = LoopDriver.restore("s-504", later, later, rig.sidecar);
        assertNotNull(restored, "the ended loop comes back until a client heard its end");
        assertFalse(restored.active());
        Host host = new Host();
        restored.host(host);
        assertEquals(LoopDriver.AGED_OUT, host.last().endedReason());
        assertTrue(host.last().endUnseen());
        assertEquals(0, later.live(), "an ended loop arms nothing");
        assertNull(LoopDriver.restore("s-504", later, later, rig.sidecar), "once heard, it stays ended");
    }

    @Test
    void anEndToldToAHostWhoseSocketHadClosedStaysUnheard(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.host.attached = false; // closed, not yet detached
        rig.driver.userAbort();
        assertNull(rig.lastLine("loop_end_seen"), "nobody heard it");
        Host back = new Host();
        rig.driver.host(back);
        assertTrue(back.last().endUnseen(), "the next client is told");
    }

    @Test
    void anEndAnAttachedClientHeardIsNotToldAgain(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        rig.driver.userAbort();
        assertTrue(rig.host.last().endUnseen(), "the end itself carries the flag once");
        Host back = new Host();
        rig.driver.host(back);
        assertFalse(back.last().endUnseen());
    }

    @Test
    void theSidecarHasALineForEachStep(@TempDir Path dir) {
        Rig rig = new Rig(dir);
        rig.start("watch", null);
        LoopDriver.Scheduled s = rig.driver.schedule(60.0, "r", LoopPrompts.SENTINEL, false);
        rig.runEnds();
        rig.timer.advanceTo(s.scheduledFor());
        rig.driver.userAbort();
        // Fix round 1: the attached client heard the end, which is a line too.
        assertEquals(List.of("loop_start", "wakeup_armed", "loop_fire", "loop_end", "loop_end_seen"),
                rig.lineTypes());
        JsonNode armedLine = rig.lastLine("wakeup_armed");
        assertEquals(60, armedLine.path("delaySeconds").asInt());
        assertEquals(LoopPrompts.SENTINEL, armedLine.path("prompt").asText());
    }

    @Test
    void theGoalCheckInIsALineOfTheSidecar(@TempDir Path dir) {
        LoopSidecar sidecar = new LoopSidecar(dir);
        sidecar.checkIn("s-504", 2, 60, 3);
        JsonNode line = sidecar.read("s-504").get(0);
        assertEquals("goal_checkin", line.path("type").asText());
        assertEquals(2, line.path("count").asInt());
        assertEquals(60, line.path("deferredMinutes").asLong());
        assertEquals(3, line.path("children").asInt());
    }

    @Test
    void theNumbersAreTheGovernedOnes() {
        assertEquals(60, LoopLimits.MIN_DELAY_SECONDS);
        assertEquals(3_600, LoopLimits.MAX_DELAY_SECONDS);
        assertEquals(1_200, LoopLimits.KEEPALIVE_SECONDS);
        assertEquals(604_800_000L, LoopLimits.MAX_AGE_MS);
        assertEquals(500, LoopLimits.TEXT_CAP);
    }
}
