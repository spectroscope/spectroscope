package dev.spectroscope.core.peer;

import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 502 criterion 7: the sender paces itself against the receiver's bucket. */
class SenderPacerTest {

    @Test
    void theSenderStopsWhereTheReceiverWouldDrop() {
        AtomicLong clock = new AtomicLong(5_000L);
        SenderPacer pacer = new SenderPacer(clock::get);
        for (int i = 0; i < PeerLimits.BUCKET_CAPACITY; i++) {
            assertTrue(pacer.tryAcquire("4711"), "send " + i);
        }
        assertFalse(pacer.tryAcquire("4711"));
        assertTrue(pacer.tryAcquire("4712"), "the pacer is per target");
        clock.addAndGet(2_000);
        assertTrue(pacer.tryAcquire("4711"));
    }

    @Test
    void thePacedTextTellsTheModelToBatch() {
        String text = SenderPacer.pacedText(30);
        assertTrue(text.contains("30 were sent recently"), text);
        assertTrue(text.contains("Batch what remains into one message"), text);
    }
}
