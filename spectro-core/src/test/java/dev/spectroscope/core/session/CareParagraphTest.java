package dev.spectroscope.core.session;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 492: the care paragraph's text is the concept's text, the helper count
 * is filled in, and the subagent sentence goes when no spawn tool is offered.
 * The expected strings are typed here from {@code konzept/RUN-PROFILES.md}
 * (Care paragraph), not read from the class under test.
 */
class CareParagraphTest {

    @Test
    void theConceptsTwoTextsHaveTheConceptsLengths() {
        assertEquals(368, CareTexts.TWO_HELPERS.length(), "premise: the typed copy is the concept's 368");
        assertEquals(306, CareTexts.NO_SUBAGENTS.length(), "premise: the typed copy is the concept's 306");
    }

    @Test
    void withTwoHelpersTheTextIsTheConceptsText() {
        assertEquals(CareTexts.TWO_HELPERS, CareParagraph.text(2, true));
    }

    @Test
    void withoutASpawnToolTheSubagentSentenceIsLeftOut() {
        assertEquals(CareTexts.NO_SUBAGENTS, CareParagraph.text(2, false));
        assertEquals(CareTexts.NO_SUBAGENTS, CareParagraph.text(7, false),
                "the count has nowhere to go when the sentence is out");
    }

    @Test
    void theHelperCountIsFilledIn() {
        assertEquals(CareTexts.TWO_HELPERS.replace("at most 2 subagents", "at most 3 subagents"),
                CareParagraph.text(3, true));
    }

    @Test
    void onlyOnTurnsItOn() {
        assertTrue(CareParagraph.enabled("on"));
        assertFalse(CareParagraph.enabled("off"));
        assertFalse(CareParagraph.enabled(null), "unset is the shipped off");
    }

    @Test
    void theSuffixIsTheSeparatorAndTheTextWhenOnAndNothingWhenOff() {
        assertEquals("\n\n" + CareTexts.TWO_HELPERS, CareParagraph.suffix("on", 2, true));
        assertEquals("\n\n" + CareTexts.NO_SUBAGENTS, CareParagraph.suffix("on", 2, false));
        assertEquals("", CareParagraph.suffix("off", 2, true));
        assertEquals("", CareParagraph.suffix(null, 2, true));
    }
}
