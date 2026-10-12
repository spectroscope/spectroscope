package dev.spectroscope.core.peer;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 502 criterion 6: the class of each of the four permission modes, and
 * "same class" for every pair of them, one test per pair.
 */
class PermissionClassTest {

    @Test
    void askIsPrompting() {
        assertEquals("prompting", PermissionClass.of("ask"));
    }

    @Test
    void autoIsBypass() {
        assertEquals("bypass", PermissionClass.of("auto"));
    }

    @Test
    void extendedIsBypass() {
        assertEquals("bypass", PermissionClass.of("extended"));
    }

    @Test
    void readonlyIsReadonly() {
        assertEquals("readonly", PermissionClass.of("readonly"));
    }

    @Test
    void anUnsetModeIsTheDefaultAskAndPrompts() {
        assertEquals("prompting", PermissionClass.of(null));
    }

    @Test
    void askWithAskIsSame() {
        assertTrue(PermissionClass.same("ask", "ask"));
    }

    @Test
    void askWithAutoIsOther() {
        assertFalse(PermissionClass.same("ask", "auto"));
    }

    @Test
    void askWithExtendedIsOther() {
        assertFalse(PermissionClass.same("ask", "extended"));
    }

    @Test
    void askWithReadonlyIsOther() {
        assertFalse(PermissionClass.same("ask", "readonly"));
    }

    @Test
    void autoWithAskIsOther() {
        assertFalse(PermissionClass.same("auto", "ask"));
    }

    @Test
    void autoWithAutoIsSame() {
        assertTrue(PermissionClass.same("auto", "auto"));
    }

    @Test
    void autoWithExtendedIsSame() {
        assertTrue(PermissionClass.same("auto", "extended"));
    }

    @Test
    void autoWithReadonlyIsOther() {
        assertFalse(PermissionClass.same("auto", "readonly"));
    }

    @Test
    void extendedWithAskIsOther() {
        assertFalse(PermissionClass.same("extended", "ask"));
    }

    @Test
    void extendedWithAutoIsSame() {
        assertTrue(PermissionClass.same("extended", "auto"));
    }

    @Test
    void extendedWithExtendedIsSame() {
        assertTrue(PermissionClass.same("extended", "extended"));
    }

    @Test
    void extendedWithReadonlyIsOther() {
        assertFalse(PermissionClass.same("extended", "readonly"));
    }

    @Test
    void readonlyWithAskIsOther() {
        assertFalse(PermissionClass.same("readonly", "ask"));
    }

    @Test
    void readonlyWithAutoIsOther() {
        assertFalse(PermissionClass.same("readonly", "auto"));
    }

    @Test
    void readonlyWithExtendedIsOther() {
        assertFalse(PermissionClass.same("readonly", "extended"));
    }

    @Test
    void readonlyWithReadonlyIsSame() {
        assertTrue(PermissionClass.same("readonly", "readonly"));
    }

    @Test
    void aClassNameIsItsOwnClass() {
        // A frame carries the sender's CLASS, not its mode, so a class name read
        // off the wire must map to itself.
        assertEquals("bypass", PermissionClass.of("bypass"));
        assertEquals("prompting", PermissionClass.of("prompting"));
        assertTrue(PermissionClass.sameClass("bypass", PermissionClass.of("auto")));
    }

    @Test
    void anUnknownWordHasNoClassAndMatchesNothing() {
        assertEquals(null, PermissionClass.of("root"));
        assertFalse(PermissionClass.same("root", "root"));
    }
}
