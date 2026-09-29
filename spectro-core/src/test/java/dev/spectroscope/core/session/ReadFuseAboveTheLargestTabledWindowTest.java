package dev.spectroscope.core.session;

import dev.spectroscope.core.tools.ReadBudget;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 456: the fuse is meant to catch only what the share would not admit on
 * any window in {@link ModelWindows#TABLE}. The largest is read from the
 * table, so a new row above today's largest turns this red instead of quietly
 * putting the fuse under the share. A window a backend publishes for itself
 * (card 391) is not in the table and is not covered here.
 */
class ReadFuseAboveTheLargestTabledWindowTest {

    @Test
    void theFuseSitsAboveWhatTheShareAdmitsOnTheLargestTabledWindow() {
        int largest = ModelWindows.TABLE.stream().mapToInt(ModelWindows.Entry::tokens).max()
                .orElseThrow();
        long shareBytes = (long) largest * ReadBudget.WINDOW_SHARE_PERCENT / 100
                * ReadBudget.BYTES_PER_TOKEN;

        assertTrue(ReadBudget.FUSE_BYTES >= shareBytes, "the fuse (" + ReadBudget.FUSE_BYTES
                + " bytes) sits under what the share admits on a " + largest
                + "-token window (" + shareBytes + " bytes)");
    }
}
