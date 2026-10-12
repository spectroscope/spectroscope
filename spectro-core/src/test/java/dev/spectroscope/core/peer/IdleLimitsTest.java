package dev.spectroscope.core.peer;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Card 503, criterion 4: the three numbers of an idle subscription, pinned by
 * their literal values rather than by the constants themselves.
 */
class IdleLimitsTest {

    @Test
    void anIdleSubscriptionLivesTwelveHours() {
        assertEquals(12 * 3_600_000L, PeerLimits.IDLE_LIFETIME_MS);
    }

    @Test
    void theIdleDebounceIs750Milliseconds() {
        assertEquals(750, PeerLimits.IDLE_DEBOUNCE_MS);
    }

    @Test
    void anIdleNoticeQuotesAtMost100Characters() {
        assertEquals(100, PeerLimits.IDLE_TEXT_CAP);
    }
}
