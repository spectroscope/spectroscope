package dev.spectroscope.core.goal;

import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 504, criterion 3: the check in clock. Intervals of 30, 60, 120 minutes
 * and then 120, from the two governed numbers, measured on a fake clock.
 */
class GoalCheckInTest {

    private static final long MIN = 60_000L;

    @Test
    void theShippedNumbersAreThirtyMinutesAndTwoDoublings() {
        assertEquals(30, GoalCheckIn.GOAL_CHECKIN_MINUTES);
        assertEquals(2, GoalCheckIn.GOAL_CHECKIN_DOUBLINGS);
        assertEquals(30 * MIN, GoalCheckIn.FIRST_INTERVAL_MS);
    }

    @Test
    void theIntervalsAreThirtySixtyOneTwentyAndThenOneTwenty() {
        AtomicLong clock = new AtomicLong(1_000_000L);
        GoalCheckIn schedule = new GoalCheckIn(30 * MIN, clock::get);
        long[] waits = new long[5];
        for (int i = 0; i < waits.length; i++) {
            waits[i] = schedule.waitMs();
            clock.addAndGet(waits[i]);
            schedule.checkedIn();
        }
        assertEquals(30 * MIN, waits[0]);
        assertEquals(60 * MIN, waits[1]);
        assertEquals(120 * MIN, waits[2]);
        assertEquals(120 * MIN, waits[3]);
        assertEquals(120 * MIN, waits[4]);
    }

    @Test
    void timeSpentSinceTheLastCheckInCountsTowardsTheNextOne() {
        AtomicLong clock = new AtomicLong(0L);
        GoalCheckIn schedule = new GoalCheckIn(30 * MIN, clock::get);
        clock.addAndGet(schedule.waitMs());
        schedule.checkedIn();
        clock.addAndGet(10 * MIN); // the model's turn
        assertEquals(50 * MIN, schedule.waitMs());
        clock.addAndGet(70 * MIN); // overdue
        assertEquals(0L, schedule.waitMs(), "an overdue check in waits for nothing");
    }

    @Test
    void theDeferredMinutesCountFromTheStartOfTheDeferral() {
        AtomicLong clock = new AtomicLong(0L);
        GoalCheckIn schedule = new GoalCheckIn(30 * MIN, clock::get);
        schedule.waitMs();
        clock.addAndGet(30 * MIN);
        schedule.checkedIn();
        clock.addAndGet(60 * MIN);
        assertEquals(90, schedule.deferredMinutes());
        assertEquals(1, schedule.count());
    }

    @Test
    void aResetDropsTheDeferralAndTheNextOneStartsAtThirtyMinutes() {
        AtomicLong clock = new AtomicLong(0L);
        GoalCheckIn schedule = new GoalCheckIn(30 * MIN, clock::get);
        for (int i = 0; i < 3; i++) {
            clock.addAndGet(schedule.waitMs());
            schedule.checkedIn();
        }
        assertTrue(schedule.deferring());
        schedule.reset();
        assertEquals(false, schedule.deferring());
        assertEquals(0, schedule.count());
        clock.addAndGet(5 * MIN);
        assertEquals(30 * MIN, schedule.waitMs(), "a fresh deferral starts at the first interval");
    }

    @Test
    void theCheckInTextNamesTheGoalTheMinutesAndTheChildren() {
        String text = GoalCheckIn.text("The tests are green.", 30, "  explore-1 · explore · still running · reading\n");
        assertTrue(text.startsWith("Goal check-in: «The tests are green.» is still active"), text);
        assertTrue(text.contains("deferred for 30 min"), text);
        assertTrue(text.contains("explore-1 · explore · still running · reading"), text);
        assertTrue(text.contains("keep waiting"), text);
        assertTrue(text.contains("stop"), text);
    }
}
