package dev.spectroscope.core.peer;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 502 criterion 8: the sender's notice for every status. */
class PeerNoticesTest {

    @Test
    void heldSaysDoNotWait() {
        String text = PeerNotices.notice(PeerStatus.HELD, "ForgeDemo-7f", null, false);
        assertTrue(text.startsWith("[Delivery notice] "), text);
        assertTrue(text.contains("ForgeDemo-7f"), text);
        assertTrue(text.contains("Do not wait for a reply"), text);
    }

    @Test
    void deniedSaysDoNotWait() {
        assertTrue(PeerNotices.notice(PeerStatus.DENIED, "x", null, false).contains("Do not wait for a reply"));
    }

    @Test
    void expiredSaysDoNotWait() {
        assertTrue(PeerNotices.notice(PeerStatus.EXPIRED, "x", null, false).contains("Do not wait for a reply"));
    }

    @Test
    void refusedSaysDoNotWait() {
        String text = PeerNotices.notice(PeerStatus.REFUSED, "x", null, false);
        assertTrue(text.contains("Do not wait for a reply"), text);
        assertTrue(text.contains("not accepting messages"), text);
    }

    @Test
    void droppedSaysDoNotResendAndFoldItIntoOneLaterMessage() {
        String text = PeerNotices.notice(PeerStatus.DROPPED, "x", DropReason.RATE_LIMITED, false);
        assertTrue(text.contains("Do not resend now"), text);
        assertTrue(text.contains("fold it into one later message"), text);
        assertTrue(text.contains(DropReason.RATE_LIMITED.text()), text);
        assertFalse(text.contains("Do not wait"), text);
    }

    @Test
    void deliveredSaysItArrivedAndAfterAHoldThatItWasApproved() {
        assertTrue(PeerNotices.notice(PeerStatus.DELIVERED, "x", null, false).contains("reached"));
        assertTrue(PeerNotices.notice(PeerStatus.DELIVERED, "x", null, true).contains("approved"));
    }

    @Test
    void onlyAPlainDeliveryStaysOutOfTheModel() {
        assertFalse(PeerNotices.tellsTheModel(PeerStatus.DELIVERED, false));
        assertTrue(PeerNotices.tellsTheModel(PeerStatus.DELIVERED, true));
        for (PeerStatus status : new PeerStatus[] {PeerStatus.HELD, PeerStatus.DENIED, PeerStatus.EXPIRED,
                PeerStatus.REFUSED, PeerStatus.DROPPED}) {
            assertTrue(PeerNotices.tellsTheModel(status, false), status.name());
        }
    }
}
