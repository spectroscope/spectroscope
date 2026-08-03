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
 * rather than buying speed. Descending, the import first fails at 768m of three
 * concurrent and at 256m of a single one, which is where the floor below comes
 * from: roughly eight times the file, because {@code content()} holds the whole
 * transcript as a UTF-16 String plus the response copy.
 */
class HeapBudgetTest {

    private static final long MIB = 1L << 20;
    private static final long GIB = 1L << 30;
    /** The cap {@code ClaudeTranscriptsController.MAX_CONTENT_BYTES} enforces today. */
    private static final long CAP = 64 * MIB;

    @Test
    void oneNumberIsPassedByEveryLauncherWeControl() {
        // A percentage, never a literal: -Xmx16g would be a cut on a bigger
        // machine and an overcommit on a smaller one. 33 is a third.
        assertEquals(33, HeapBudget.MAX_RAM_PERCENT);
        assertEquals("-XX:MaxRAMPercentage=33", HeapBudget.FLAG);
    }

    @Test
    void theFloorFollowsTheImportCap() {
        // The cap IS the heap budget, so raising the cap must raise the floor
        // rather than silently moving the point where an import dies.
        assertEquals(512 * MIB, new HeapBudget(4 * GIB, 16 * GIB, CAP).floorBytes());
        assertEquals(1024 * MIB, new HeapBudget(4 * GIB, 16 * GIB, 2 * CAP).floorBytes());
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
        String warning = new HeapBudget(384 * MIB, 2 * GIB, CAP).warning().orElseThrow();
        assertTrue(warning.contains("384 MiB"), warning);
        assertTrue(warning.contains("512 MiB"), warning);
        assertTrue(warning.contains("64 MiB"), warning);
        assertTrue(warning.contains(HeapBudget.FLAG), warning);
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
        assertTrue(line.contains("64 MiB"), line);
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
