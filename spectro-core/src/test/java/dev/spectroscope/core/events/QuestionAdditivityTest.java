package dev.spectroscope.core.events;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 265: the two lines that say a run stopped and asked a person something.
 *
 * <p>They are deliberately NOT folded into the permission pair. A gate is a
 * yes/no on a side effect and its record carries a boolean; a question carries
 * text, and a trace whose only shape for "a human was consulted" is a boolean
 * cannot say what was asked or what came back.</p>
 *
 * <p>Additive on the card-72/184/195/204/252 precedent: no existing line moves,
 * and a reader that has never heard of these two types must survive them.</p>
 */
class QuestionAdditivityTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private RunEvent.QuestionAsked asked() {
        return new RunEvent.QuestionAsked("main", "call-1", List.of(
                new RunEvent.AskedQuestion("Which store?", "Storage", false, List.of(
                        new RunEvent.QuestionOption("Postgres", "the one already in the compose file"),
                        new RunEvent.QuestionOption("SQLite", null)))), 7L);
    }

    private RunEvent.QuestionAnswered answered() {
        return new RunEvent.QuestionAnswered("call-1", List.of("Postgres"), false, 240_000L, 9L);
    }

    @Test
    void theAskRoundTripsThroughTheWire() throws Exception {
        String line = JSON.writeValueAsString(asked());
        RunEvent.QuestionAsked back = (RunEvent.QuestionAsked) JSON.readValue(line, RunEvent.class);
        assertEquals(asked(), back, "the record is the contract; a lossy field is a lost fact");
        assertTrue(line.contains("\"type\":\"question_asked\""), line);
        assertTrue(line.contains("\"question\":\"Which store?\""), line);
        assertTrue(line.contains("\"header\":\"Storage\""), line);
        assertTrue(line.contains("\"multiSelect\":false"), line);
        assertTrue(line.contains("\"label\":\"Postgres\""), line);
    }

    @Test
    void theAnswerRoundTripsAndCarriesTheHumanWait() throws Exception {
        String line = JSON.writeValueAsString(answered());
        RunEvent.QuestionAnswered back =
                (RunEvent.QuestionAnswered) JSON.readValue(line, RunEvent.class);
        assertEquals(answered(), back);
        assertTrue(line.contains("\"type\":\"question_answered\""), line);
        // Card 111's split, one surface further: the four minutes a person thought
        // travel HERE and never inside the tool's own durationMs.
        assertTrue(line.contains("\"waitMs\":240000"), line);
        assertFalse(back.cancelled(), "an answered question is not a cancelled one");
    }

    @Test
    void aReleasedQuestionSaysCancelledAndNeverInventsAnAnswer() throws Exception {
        // Every release path (cancel, a closed socket, no asker, an unattended
        // mode) lands here. One invented answer in a JSONL poisons the audit
        // trail permanently, so the empty list plus the flag IS the record.
        RunEvent.QuestionAnswered released =
                new RunEvent.QuestionAnswered("call-2", List.of(), true, 12L, 13L);
        String line = JSON.writeValueAsString(released);
        assertEquals(released, JSON.readValue(line, RunEvent.class));
        assertTrue(line.contains("\"cancelled\":true"), line);
        assertTrue(line.contains("\"answers\":[]"), line);
    }

    @Test
    void anAbsentOptionalStaysAbsentOnTheWire() throws Exception {
        // A question with no header and an option with no description must not
        // ship "" — an empty string reads as a header whose text is empty.
        String line = JSON.writeValueAsString(new RunEvent.QuestionAsked("main", "call-3", List.of(
                new RunEvent.AskedQuestion("Ship it?", null, false,
                        List.of(new RunEvent.QuestionOption("yes", null)))), 1L));
        assertFalse(line.contains("header"), line);
        assertFalse(line.contains("description"), line);
        // And the wait is absent, not zero, when nothing was ever measured.
        String noWait = JSON.writeValueAsString(
                new RunEvent.QuestionAnswered("call-3", List.of(), true, null, 2L));
        assertFalse(noWait.contains("waitMs"), noWait);
        assertNull(((RunEvent.QuestionAnswered) JSON.readValue(noWait, RunEvent.class)).waitMs());
    }

    @Test
    void anOlderLineOfEveryOtherTypeStillParses() throws Exception {
        String old = "{\"type\":\"turn_start\",\"agentId\":\"main\",\"turn\":1,\"ts\":5}";
        assertEquals(1, ((RunEvent.TurnStart) JSON.readValue(old, RunEvent.class)).turn());
    }

    @Test
    void aReaderSurvivesFieldsItDoesNotKnow() throws Exception {
        String fromTheFuture = "{\"type\":\"question_answered\",\"callId\":\"c\",\"answers\":[\"a\"],"
                + "\"cancelled\":false,\"waitMs\":5,\"ts\":1,\"answeredBy\":\"somebody-later\"}";
        RunEvent.QuestionAnswered read =
                (RunEvent.QuestionAnswered) JSON.readValue(fromTheFuture, RunEvent.class);
        assertEquals(List.of("a"), read.answers());
    }
}
