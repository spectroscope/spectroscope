package dev.spectroscope.core.peer;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
    void aReturnedMessageNamesTheHelperWhyItEndedAndTheStartOfTheMessage() {
        // Card 594: the line a sender reads when a helper ended with its message unread.
        String line = PeerNotices.returned("explore-2", "did not start: no thread", "status?\nand the tests", true);
        assertTrue(line.startsWith("[Delivery notice] Your message to explore-2 was not delivered"), line);
        assertTrue(line.contains("did not start: no thread"), line);
        assertTrue(line.contains("«status? and the tests»"), "one line, quoted whole: " + line);
        assertTrue(line.contains("Do not wait for a reply"), line);
        String toOperator = PeerNotices.returned("explore-2", "did not start: no thread", "status?", false);
        assertTrue(toOperator.contains("explore-2") && toOperator.contains("«status?»"), toOperator);
        assertFalse(toOperator.contains("Do not wait"), "the operator's line gives the model no advice: " + toOperator);
    }

    @Test
    void aReturnedMessageIsQuotedUpToTheSummaryCapAndACutIsMarked() {
        String longer = "a".repeat(PeerLimits.SUMMARY_CAP + 10);
        assertTrue(PeerNotices.returned("explore-1", "x", longer, false)
                .contains("«" + "a".repeat(PeerLimits.SUMMARY_CAP) + "…»"), "cut and marked");
        String exact = "b".repeat(PeerLimits.SUMMARY_CAP);
        assertTrue(PeerNotices.returned("explore-1", "x", exact, false).contains("«" + exact + "»"),
                "a message that fits is quoted whole, with no mark");
    }

    @Test
    void theReturnedLineIsTheOneTheChatReads() throws java.io.IOException {
        // Card 594, review M3: the chat reads the reason and the start of the
        // message out of this line, and its test reads the same file.
        java.nio.file.Path root = java.nio.file.Path.of("").toAbsolutePath();
        while (root != null && !java.nio.file.Files.isRegularFile(root.resolve("settings.gradle.kts"))) {
            root = root.getParent();
        }
        assertTrue(root != null, "premise: running from a source checkout");
        String fixture = java.nio.file.Files.readString(root.resolve("spectro-web/src/testkit/returnedLine.txt"));
        assertEquals(fixture.strip(), PeerNotices.returned("explore-2",
                "ended by cancellation of the parent run while it waited for a free slot", "status?", true));
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
