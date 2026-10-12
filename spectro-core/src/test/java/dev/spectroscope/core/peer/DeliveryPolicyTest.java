package dev.spectroscope.core.peer;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** Card 502 criterion 6: what the receiving side does, one test per state. */
class DeliveryPolicyTest {

    @Test
    void aRunThatIsUpAndAttendedQueuesForTheNextSafePoint() {
        assertEquals(DeliveryPolicy.Action.QUEUE, DeliveryPolicy.decide(true, true, true, "ask", "bypass"));
    }

    @Test
    void anIdleAttendedSessionOfTheSameClassStartsARun() {
        assertEquals(DeliveryPolicy.Action.START_RUN, DeliveryPolicy.decide(true, true, false, "auto", "bypass"));
        assertEquals(DeliveryPolicy.Action.START_RUN, DeliveryPolicy.decide(true, true, false, "ask", "prompting"));
        assertEquals(DeliveryPolicy.Action.START_RUN, DeliveryPolicy.decide(true, true, false, "readonly", "readonly"));
    }

    @Test
    void anIdleAttendedSessionOfAnotherClassHolds() {
        assertEquals(DeliveryPolicy.Action.HOLD, DeliveryPolicy.decide(true, true, false, "ask", "bypass"));
        assertEquals(DeliveryPolicy.Action.HOLD, DeliveryPolicy.decide(true, true, false, "readonly", "bypass"));
        assertEquals(DeliveryPolicy.Action.HOLD, DeliveryPolicy.decide(true, true, false, "auto", "prompting"));
    }

    @Test
    void aSenderThatStatesNoClassIsHeldByAnIdleSession() {
        assertEquals(DeliveryPolicy.Action.HOLD, DeliveryPolicy.decide(true, true, false, "auto", null));
    }

    @Test
    void anUnattendedFaceRefuses() {
        assertEquals(DeliveryPolicy.Action.REFUSE, DeliveryPolicy.decide(false, true, true, "auto", "bypass"));
        assertEquals(DeliveryPolicy.Action.REFUSE, DeliveryPolicy.decide(false, true, false, "auto", "bypass"));
    }

    @Test
    void aSessionThatIsNotAcceptingRefuses() {
        assertEquals(DeliveryPolicy.Action.REFUSE, DeliveryPolicy.decide(true, false, true, "auto", "bypass"));
    }
}
