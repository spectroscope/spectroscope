package dev.spectroscope.cli;

import dev.spectroscope.core.Asker;
import dev.spectroscope.core.events.RunEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.BufferedReader;
import java.io.StringReader;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * Card 265 on the other face that has a person: the interactive terminal.
 *
 * <p>The split mirrors the gate's exactly — {@code EventRenderer} prints the
 * question when the {@code question_asked} event reaches it, and this reads one
 * line off the same stdin the REPL and the permission broker already share. It
 * never prints, so the two can never disagree about what was asked.</p>
 *
 * <p>EOF is the case worth its own test: {@code readLine} returning null is a
 * pipe that closed, which in the gate is a denial and here must be "nobody
 * answered". A denial is a verdict; an EOF is an absence.</p>
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class ConsoleAskerTest {

    private static RunEvent.QuestionAsked question(boolean multiSelect) {
        return new RunEvent.QuestionAsked("main", "c1", List.of(
                new RunEvent.AskedQuestion("Which store?", "Storage", multiSelect, List.of(
                        new RunEvent.QuestionOption("Postgres", null),
                        new RunEvent.QuestionOption("SQLite", null)))), 1L);
    }

    private static Asker.Answer askWith(String typed, boolean multiSelect) {
        return new ConsoleAsker(new BufferedReader(new StringReader(typed))).ask(question(multiSelect));
    }

    @Test
    void aNumberPicksThatOptionsLabel() {
        assertEquals(List.of("Postgres"), askWith("1\n", false).answers());
        assertEquals(List.of("SQLite"), askWith("2\n", false).answers());
    }

    @Test
    void aNumberNobodyOfferedIsTheirOwnWords() {
        // "9" is not option nine; there is no option nine. Treating it as one
        // would record a choice that was never offered.
        assertEquals(List.of("9"), askWith("9\n", false).answers());
    }

    @Test
    void freeTextPassesThroughVerbatim() {
        assertEquals(List.of("neither — use the one in docker-compose"),
                askWith("neither — use the one in docker-compose\n", false).answers());
    }

    @Test
    void severalNumbersPickSeveralLabelsOnlyWhenTheQuestionAllowsIt() {
        assertEquals(List.of("Postgres, SQLite"), askWith("1,2\n", true).answers(),
                "the joined labels are the wording the transcript renderer reads back");
        assertEquals(List.of("1,2"), askWith("1,2\n", false).answers(),
                "a single-choice question was not offering a pair, so it stays their words");
    }

    @Test
    void anEmptyLineSkipsAndIsNotAnEmptyAnswer() {
        assertNull(askWith("\n", false),
                "a person pressing enter has skipped; \"\" would be them saying nothing");
    }

    @Test
    void endOfInputIsUnansweredAndNeverADenial() {
        assertNull(askWith("", false));
    }
}
