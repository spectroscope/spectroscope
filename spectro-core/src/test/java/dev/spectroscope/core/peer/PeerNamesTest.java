package dev.spectroscope.core.peer;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 502 criterion 12: names, their source and their uniqueness. */
class PeerNamesTest {

    @Test
    void aDerivedNameIsTheFolderBasenameAndTwoHex() {
        String name = PeerNames.derive("/Users/someone/ForgeDemo", "20261011-090000-abcdef12");
        assertTrue(name.matches("ForgeDemo-[0-9a-f]{2}"), name);
        assertEquals(name, PeerNames.derive("/Users/someone/ForgeDemo", "20261011-090000-abcdef12"),
                "stable for one session");
    }

    @Test
    void theSessionTitleWinsWhenSet() {
        PeerNames.Named named = PeerNames.name("/x/ForgeDemo", "s1", "Fix the login page");
        assertEquals("Fix-the-login-page", named.name());
        assertEquals("title", named.source());
        PeerNames.Named derived = PeerNames.name("/x/ForgeDemo", "s1", "  ");
        assertEquals("derived", derived.source());
    }

    @Test
    void matchingIsNfkcAndLowerCase() {
        assertTrue(PeerNames.same("ＦｏｒｇｅＤｅｍｏ-7f", "forgedemo-7f"));
        assertFalse(PeerNames.same("ForgeDemo-7f", "ForgeDemo-7e"));
    }

    @Test
    void theLaterClaimantYieldsByStartedAtThenProcStartThenPid() {
        PeerNames.Claim early = new PeerNames.Claim(100L, "2026-10-11T08:00:00.000Z", 50, "s1", "Build");
        PeerNames.Claim late = new PeerNames.Claim(200L, "2026-10-11T07:00:00.000Z", 10, "s2", "Build");
        assertTrue(PeerNames.yields(late, List.of(early, late)));
        assertFalse(PeerNames.yields(early, List.of(early, late)));
        PeerNames.Claim sameTimeLaterStart = new PeerNames.Claim(100L, "2026-10-11T09:00:00.000Z", 1, "s3", "build");
        assertTrue(PeerNames.yields(sameTimeLaterStart, List.of(early, sameTimeLaterStart)));
        PeerNames.Claim sameTimeHigherPid = new PeerNames.Claim(100L, "2026-10-11T08:00:00.000Z", 60, "s4", "BUILD");
        assertTrue(PeerNames.yields(sameTimeHigherPid, List.of(early, sameTimeHigherPid)));
        PeerNames.Claim other = new PeerNames.Claim(1L, "2001-01-01T00:00:00.000Z", 1, "s5", "Deploy");
        assertFalse(PeerNames.yields(late, List.of(other, late)), "no contest without the same name");
    }

    @Test
    void theLoserTakesBaseAdjectiveNoun() {
        String renamed = PeerNames.loserName("ForgeDemo-7f", "s2");
        assertTrue(renamed.matches("ForgeDemo-7f-[a-z]+-[a-z]+"), renamed);
        assertEquals(renamed, PeerNames.loserName("ForgeDemo-7f", "s2"));
        assertNotEquals(renamed, PeerNames.loserName("ForgeDemo-7f", "s3"));
    }

    @Test
    void aNameKeepsOnlyLettersDigitsDotsUnderscoresAndHyphens() {
        assertEquals("operator-the-person-watching", PeerNames.clean("operator (the person watching)"));
        assertEquals("a-b", PeerNames.clean("a\"><b"));
        assertEquals("Café_2.0-x", PeerNames.clean("  Café_2.0 x  "));
        assertEquals("forgedemo-7f", PeerNames.clean("ｆｏｒｇｅｄｅｍｏ-7f"), "NFKC first");
        assertEquals("", PeerNames.clean("()"));
        assertEquals("", PeerNames.clean(null));
    }

    @Test
    void aTitleWithNothingLeftAfterCleaningFallsBackToTheDerivedName() {
        PeerNames.Named named = PeerNames.name("/x/ForgeDemo", "s1", "(  )");
        assertEquals("derived", named.source());
        assertTrue(named.name().matches("ForgeDemo-[0-9a-f]{2}"), named.name());
    }
}
