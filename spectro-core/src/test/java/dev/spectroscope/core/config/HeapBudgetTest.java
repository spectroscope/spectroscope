package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The heap budget: what the JVM actually granted this process, said once, plus
 * the single case worth shouting about.
 *
 * <p>The numbers below are measured, not guessed. On a 48 GiB machine a fresh
 * JVM takes {@code MaxHeapSize = 12884901888} because {@code MaxRAMPercentage}
 * defaults to 25. Three concurrent imports of a real 47 MB transcript peaked at
 * 2.65 GB used against that ceiling and held 18 MB live afterwards; the same
 * work under {@code -Xmx2g} peaked at 1.46 GB and returned the same bytes. So
 * the ceiling is not the constraint, and a bigger ceiling costs resident memory
 * rather than buying speed.
 *
 * <p>Those descending numbers, the import first failing at 768m of three
 * concurrent and at 256m of a single one, described a {@code content()} that held
 * the whole transcript as a UTF-16 String plus the response copy. It streams now.
 * Re-measured 2026-08-03 on the same machine against the same store: three
 * concurrent reads of the 82.9 MiB transcript complete on {@code -Xmx128m}, so
 * the floor is a constant working set rather than a multiple of the cap.
 */
class HeapBudgetTest {

    private static final long MIB = 1L << 20;
    private static final long GIB = 1L << 30;
    /** The cap {@code ClaudeTranscriptsController.MAX_CONTENT_BYTES} enforces today. */
    private static final long CAP = 128 * MIB;

    @Test
    void oneNumberIsPassedByEveryLauncherWeControl() {
        // A percentage, never a literal: -Xmx16g would be a cut on a bigger
        // machine and an overcommit on a smaller one. 33 is a third.
        assertEquals(33, HeapBudget.MAX_RAM_PERCENT);
        assertEquals("-XX:MaxRAMPercentage=33", HeapBudget.FLAG);
    }

    /**
     * The floor stopped following the cap, because the read stopped following
     * the file. This replaces {@code theFloorFollowsTheImportCap}, whose premise
     * was that {@code content()} holds the whole transcript as a UTF-16 String
     * plus the response copy. It did, and the arithmetic was right for that code.
     * It streams now, so the premise is gone and the threshold was not loosened,
     * it was measured out of existence.
     *
     * <p>Measured 2026-08-03 against the 0.5.0 jar over the real store, server
     * started with {@code -Xmx128m}: the 73.6 MiB transcript served in 126 ms
     * byte-identical, the 82.9 MiB one in 175 ms, and THREE concurrent reads of
     * the 82.9 MiB one all returned 86,913,996 bytes with zero
     * OutOfMemoryError in the log. The old numbers in this class said three
     * concurrent needed between 768 MiB and 1 GiB. That was true of readString
     * and is false now, on the same machine, against the same files.
     */
    @Test
    void theFloorDoesNotFollowTheImportCapBecauseTheReadIsStreamed() {
        long small = new HeapBudget(4 * GIB, 16 * GIB, CAP).floorBytes();
        long huge = new HeapBudget(4 * GIB, 16 * GIB, 16 * CAP).floorBytes();
        assertEquals(small, huge,
                "the floor still scales with the import cap, but a streamed read does not"
                        + " hold the file, so raising the cap no longer raises the heap demand");
    }

    @Test
    void aCeilingAboveTheFloorSaysNothing() {
        // 2 GiB is what an 8 GiB laptop gets from the JVM's own default today,
        // and it completed the hardest import measured. Silence is correct.
        assertTrue(new HeapBudget(2 * GIB, 8 * GIB, CAP).warning().isEmpty());
        assertTrue(new HeapBudget(512 * MIB, 2 * GIB, CAP).warning().isEmpty());
    }

    @Test
    void aCeilingUnderTheFloorNamesTheFlagAndTheNumbers() {
        // The case a fixed -Xmx or a tight cgroup produces. Warn with the fix in
        // the sentence, because whoever reads this line is not holding the card.
        // 128 MiB is not hypothetical: it is what the streaming read was proven
        // on live, and the boot log did print this warning on that run.
        String warning = new HeapBudget(128 * MIB, 2 * GIB, CAP).warning().orElseThrow();
        assertTrue(warning.contains("128 MiB"), warning);
        assertTrue(warning.contains("256 MiB"), warning);
        assertTrue(warning.contains(HeapBudget.FLAG), warning);
    }

    @Test
    void theWarningDoesNotBlameTheCapForANumberTheCapDoesNotMove() {
        // "under the 256 MiB one transcript import at the 128 MiB cap needs" is
        // true at the shipped cap and names a cause that does not exist: lower
        // the cap and the sentence still says 256 MiB. A reader who takes the
        // sentence at its word lowers the cap to make the warning go away, and
        // it does not move. The floor is measured, so the sentence says so.
        String lowered = new HeapBudget(64 * MIB, 2 * GIB, 8 * MIB).warning().orElseThrow();
        assertFalse(lowered.contains("8 MiB cap"), lowered);
        assertTrue(lowered.contains("256 MiB"), lowered);
        assertTrue(lowered.contains(HeapBudget.FLAG), lowered);

        // And the sentence must not change with the cap at all, because the
        // number in it does not.
        String shipped = new HeapBudget(64 * MIB, 2 * GIB, CAP).warning().orElseThrow();
        assertEquals(shipped, lowered,
                "the warning still varies with the import cap, but the floor it reports does not");
    }

    @Test
    void theLineAnswersHowMuchHeapWeHave() {
        // The owner's actual question. The share is what makes a missing flag
        // visible: 25 percent means no launcher passed anything.
        // 17_012_097_024 is what this machine measured under the flag: 33% of 48 GiB.
        String line = new HeapBudget(17_012_097_024L, 48 * GIB, CAP).line();
        assertTrue(line.contains("15.8 GiB"), line);
        assertTrue(line.contains("48.0 GiB"), line);
        assertTrue(line.contains("33%"), line);
        assertTrue(line.contains("128 MiB"), line);
    }

    @Test
    void theLineDropsTheShareWhenTheMachineSizeIsUnknown() {
        // getTotalMemorySize is a JDK extension. If it is ever unavailable the
        // line must still answer the question, minus the part it cannot know.
        String line = new HeapBudget(2 * GIB, 0, CAP).line();
        assertTrue(line.contains("2.0 GiB"), line);
        assertFalse(line.contains("%"), line);
    }

    @Test
    void measuringThisJvmNeverThrows() {
        // Called from main() before Spring starts. A courtesy line must not be
        // the reason a server refuses to boot.
        HeapBudget measured = HeapBudget.measure(CAP);
        assertTrue(measured.maxHeapBytes() > 0);
        assertTrue(measured.physicalBytes() >= 0);
        assertFalse(measured.line().isBlank());
    }
}
