package dev.spectroscope.cli;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * A message from the fleet view as a trigger fire (card 166's last inch): the
 * node that lingers already knows how to run again — a message is simply
 * another thing that fires it. The verb's delivery is the orchestrator's; this
 * is what the words become once they arrive.
 *
 * <p>The insert semantics are the point. The slot holds ONE fire, and http and
 * timer are REFUSED while it is full — correct for those, because the caller
 * gets a 429 and stays the retry authority. A message has no such caller: the
 * endpoint already answered 202, and the operator is a person who typed a
 * sentence. Refusing it would drop their words with nobody to tell, which is
 * the exact failure the wire's version bump exists to prevent. So messages
 * MERGE, like fs — words from one person accumulate.</p>
 */
class MessageFireTest {

    @Test
    void aMessageFireCarriesTheWordsIntoTheRun() {
        Fire fire = Fire.message("read the second file too");
        assertEquals("message", fire.kind());

        String block = fire.contextBlock(3);
        assertTrue(block.contains("read the second file too"), block);
        assertTrue(block.startsWith("[trigger message #3]"), block);
    }

    @Test
    void theOperatorsWordsAreNotLabelledUntrustedInput() {
        // An http payload is labelled as untrusted data on purpose — it arrives
        // from whoever can reach the trigger port. A message cannot: it comes
        // from the operator's own fleet view, behind the local-origin fence, and
        // telling the agent to distrust its operator would make the feature
        // useless. This asymmetry is deliberate and worth pinning.
        String http = Fire.http("listen:127.0.0.1:8300", "do a thing", "127.0.0.1").contextBlock(1);
        assertTrue(http.contains("untrusted input"), http);

        String message = Fire.message("do a thing").contextBlock(1);
        assertFalse(message.contains("untrusted"), message);
    }

    @Test
    void aSecondMessageMergesInsteadOfBeingDropped() throws Exception {
        FireSlot slot = new FireSlot();

        assertEquals(FireSlot.Disposition.ACCEPTED, slot.offer(Fire.message("first thing")));
        assertEquals(FireSlot.Disposition.COALESCED, slot.offer(Fire.message("second thing")),
                "a message offered while one waits merges — nobody is left to retry it");

        Fire merged = slot.take();
        String block = merged.contextBlock(1);
        assertTrue(block.contains("first thing"), block);
        assertTrue(block.contains("second thing"), block);
        // `coalesced` counts the LATER fires folded in, so two sentences is one
        // merge — the run is told it is answering more than one thing.
        assertTrue(block.contains("1 coalesced"), "the block says how many were folded in: " + block);
        assertTrue(block.indexOf("first thing") < block.indexOf("second thing"),
                "and in the order they were said: " + block);
    }

    @Test
    void aMessageDoesNotMergeWithAnotherKind() {
        // Merging across kinds would fold a directory statement into a sentence.
        FireSlot fsFirst = new FireSlot();
        fsFirst.offer(Fire.fs("watch:/tmp", java.util.List.of("created a.csv"), 0, false));
        assertEquals(FireSlot.Disposition.REFUSED, fsFirst.offer(Fire.message("hello")));

        FireSlot msgFirst = new FireSlot();
        msgFirst.offer(Fire.message("hello"));
        assertEquals(FireSlot.Disposition.REFUSED,
                msgFirst.offer(Fire.fs("watch:/tmp", java.util.List.of("created a.csv"), 0, false)));
    }

    @Test
    void aMessageAfterAStopIsRefusedLikeEverythingElse() {
        // Nothing may run after a stop — a message is no exception, and the
        // node's exit must not be held open by late words.
        FireSlot slot = new FireSlot();
        slot.stop();
        assertEquals(FireSlot.Disposition.REFUSED, slot.offer(Fire.message("one more thing")));
    }
}
