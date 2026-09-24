package dev.spectroscope.core.session;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 390: the holder of the window the operator set for a session. Zero is
 * how "none" is spelled, so it is never a value somebody can set.
 */
class SessionWindowTest {

    @Test
    void aFreshHolderSetsNothing() {
        SessionWindow window = new SessionWindow();
        assertEquals(0, window.tokens());
        assertFalse(window.isSet());
    }

    @Test
    void aSetValueIsReadBackAndAClearRemovesIt() {
        SessionWindow window = new SessionWindow();
        window.set(512_000);
        assertEquals(512_000, window.tokens());
        assertTrue(window.isSet());

        window.set(250_368);
        assertEquals(250_368, window.tokens(), "a second set replaces the first");

        window.clear();
        assertEquals(0, window.tokens());
        assertFalse(window.isSet());
    }

    @Test
    void zeroAndBelowAreRefusedBecauseZeroMeansNone() {
        SessionWindow window = new SessionWindow();
        window.set(8_000);
        assertThrows(IllegalArgumentException.class, () -> window.set(0));
        assertThrows(IllegalArgumentException.class, () -> window.set(-1));
        assertEquals(8_000, window.tokens(), "a refused set leaves the value in force");
    }
}
