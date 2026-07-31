package dev.spectroscope.cli;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The timer trigger: no fire at boot (the first fire comes after one full
 * period — a prompt written against "time passed" must not run at t=0), a
 * refused offer is a logged skip (the cron overlap precedent), and close
 * ends the ticking.
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class TimerTriggerTest {

    @Test
    void noFireAtBootThenOnePerPeriod() throws Exception {
        AtomicInteger fires = new AtomicInteger();
        CountDownLatch first = new CountDownLatch(1);
        try (TimerTrigger trigger = new TimerTrigger(200, "200ms", line -> { })) {
            assertEquals("every:200ms", trigger.describe());
            trigger.start(fire -> {
                assertEquals("timer", fire.kind());
                fires.incrementAndGet();
                first.countDown();
                return FireSlot.Disposition.ACCEPTED;
            });

            Thread.sleep(60);
            assertEquals(0, fires.get(), "no fire at boot — the first period must elapse");
            assertTrue(first.await(5, TimeUnit.SECONDS), "then the timer ticks");
        }
    }

    @Test
    void aRefusedTickIsALoggedSkipNotALoss() throws Exception {
        List<String> log = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch twoTicks = new CountDownLatch(2);
        try (TimerTrigger trigger = new TimerTrigger(150, "150ms", log::add)) {
            trigger.start(fire -> {
                twoTicks.countDown();
                return FireSlot.Disposition.REFUSED;
            });
            assertTrue(twoTicks.await(5, TimeUnit.SECONDS));
        }
        assertTrue(log.stream().anyMatch(line -> line.contains("skip")),
                "the skip is on record, matching the cron overlap-skip precedent: " + log);
    }

    @Test
    void closeStopsTheTicking() throws Exception {
        AtomicInteger fires = new AtomicInteger();
        CountDownLatch first = new CountDownLatch(1);
        TimerTrigger trigger = new TimerTrigger(100, "100ms", line -> { });
        trigger.start(fire -> {
            fires.incrementAndGet();
            first.countDown();
            return FireSlot.Disposition.ACCEPTED;
        });
        assertTrue(first.await(5, TimeUnit.SECONDS));
        trigger.close();

        int atClose = fires.get();
        Thread.sleep(350);
        assertTrue(fires.get() <= atClose + 1,
                "at most one in-flight tick after close, then silence");
    }
}
