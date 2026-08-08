package dev.spectroscope.server.shell;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The kill switch. A shell in the browser is the most dangerous surface in the
 * app, so an operator who does not want it must be able to remove the endpoint
 * outright — not merely hide the pane. Anything that reads as "no" is a no; an
 * unset value keeps the feature on, because a value nobody set is not a refusal.
 */
class ShellsTest {

    @Test
    void unsetMeansOn() {
        assertTrue(Shells.enabled(null));
        assertTrue(Shells.enabled(""));
        assertTrue(Shells.enabled("   "));
    }

    @Test
    void everythingThatReadsAsNoIsANo() {
        assertFalse(Shells.enabled("off"));
        assertFalse(Shells.enabled("OFF"));
        assertFalse(Shells.enabled("false"));
        assertFalse(Shells.enabled("0"));
        assertFalse(Shells.enabled("no"));
        assertFalse(Shells.enabled(" Off "));
    }

    @Test
    void anythingElseIsOn() {
        assertTrue(Shells.enabled("on"));
        assertTrue(Shells.enabled("true"));
        assertTrue(Shells.enabled("1"));
    }
}
