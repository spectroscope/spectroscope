package dev.spectroscope.core.local;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Before a two-gigabyte download starts, the machine gets asked whether it can
 * hold the thing. A pure fold over three numbers, so the answer is testable
 * without filling a disk.
 */
class LocalPreflightTest {

    private static final long GB = 1_000_000_000L;

    private static LocalCatalog.Model model(long size, long ram) {
        return new LocalCatalog.Model("test", "Test", "test.gguf",
                "https://example.invalid/test.gguf", "0".repeat(64), size, ram,
                4096, true, false, "apache-2.0", "https://example.invalid/licence",
                "https://example.invalid", "blurb.key", "goodfor.key", null);
    }

    @Test
    @DisplayName("a roomy machine passes on both counts")
    void roomyMachinePasses() {
        LocalPreflight.Verdict v = LocalPreflight.check(model(2 * GB, 6 * GB), 32 * GB, 200 * GB);
        assertTrue(v.ok());
        assertFalse(v.tight());
        assertTrue(v.diskOk());
        assertTrue(v.ramOk());
    }

    @Test
    @DisplayName("too little disk fails, and says disk rather than a generic no")
    void tooLittleDiskFails() {
        LocalPreflight.Verdict v = LocalPreflight.check(model(2 * GB, 6 * GB), 32 * GB, 1 * GB);
        assertFalse(v.ok());
        assertFalse(v.diskOk());
        assertTrue(v.ramOk());
    }

    @Test
    @DisplayName("the download needs headroom above the file, not exactly the file")
    void diskNeedsHeadroom() {
        assertFalse(LocalPreflight.check(model(2 * GB, 6 * GB), 32 * GB, 2 * GB).diskOk(),
                "a disk with exactly the file size left cannot also hold the .part file's move");
        assertTrue(LocalPreflight.check(model(2 * GB, 6 * GB), 32 * GB, 3 * GB).diskOk());
    }

    @Test
    @DisplayName("too little memory fails even when the disk is huge")
    void tooLittleRamFails() {
        LocalPreflight.Verdict v = LocalPreflight.check(model(2 * GB, 6 * GB), 4 * GB, 500 * GB);
        assertFalse(v.ok());
        assertTrue(v.diskOk());
        assertFalse(v.ramOk());
    }

    @Test
    @DisplayName("just enough memory is allowed, but flagged as tight")
    void justEnoughRamIsTight() {
        LocalPreflight.Verdict v = LocalPreflight.check(model(2 * GB, 6 * GB), 7 * GB, 500 * GB);
        assertTrue(v.ok(), "it fits, so do not forbid it");
        assertTrue(v.tight(), "but say so before the machine starts swapping");
    }

    @Test
    @DisplayName("an unknown machine is not a failing machine")
    void unknownNumbersDoNotBlock() {
        LocalPreflight.Verdict v = LocalPreflight.check(model(2 * GB, 6 * GB), 0, 0);
        assertTrue(v.ok(), "when the JVM cannot read the numbers, do not invent a refusal");
        assertFalse(v.known(), "but do not pretend the check happened either");
    }

    @Test
    @DisplayName("the shortfall is reported in bytes so the face can phrase it")
    void shortfallIsReported() {
        LocalPreflight.Verdict v = LocalPreflight.check(model(10 * GB, 20 * GB), 8 * GB, 3 * GB);
        assertEquals(20 * GB, v.ramNeededBytes());
        assertTrue(v.diskNeededBytes() > 10 * GB);
    }
}
