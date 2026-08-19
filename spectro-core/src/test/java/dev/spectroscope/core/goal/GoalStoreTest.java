package dev.spectroscope.core.goal;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 267 criterion 1: the goal is a durable artifact, readable and editable
 * on disk in the pattern {@code loadAgentsMd} already uses.
 */
class GoalStoreTest {

    @Test
    void itSurvivesTheRoundTrip(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s.goal.md");
        RunGoal goal = new RunGoal("The auth tests pass, including the refresh-token case.",
                "node --test test/auth.test.js");
        GoalStore.write(file, goal);
        RunGoal back = GoalStore.read(file);
        assertEquals(goal.outcome(), back.outcome());
        assertEquals(goal.check(), back.check());
    }

    @Test
    void aPersonCanReadItAndTypeOverIt(@TempDir Path dir) throws Exception {
        // Hand-written, not machine-written — which is the normal case for an
        // artifact the card says is EDITABLE on disk.
        Path file = dir.resolve("s.goal.md");
        Files.writeString(file, "# whatever heading I like\n\n"
                + "## Outcome\n\nthe build is green\n\n"
                + "## Check\n\n    ./gradlew test\n");
        RunGoal back = GoalStore.read(file);
        assertEquals("the build is green", back.outcome());
        assertEquals("./gradlew test", back.check());
    }

    @Test
    void aGoalWithoutACheckIsStoredAndComesBackWithoutOne(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("s.goal.md");
        GoalStore.write(file, new RunGoal("make it nice", null));
        RunGoal back = GoalStore.read(file);
        assertEquals("make it nice", back.outcome());
        assertNull(back.check());
    }

    @Test
    void clearingAGoalLeavesNothingBehind(@TempDir Path dir) throws Exception {
        // A withdrawn goal that a later reader re-states is the harness
        // overruling the operator with a stale file.
        Path file = dir.resolve("s.goal.md");
        GoalStore.write(file, new RunGoal("do the thing", "exit 0"));
        GoalStore.write(file, null);
        assertFalse(Files.exists(file));
        assertNull(GoalStore.read(file));
    }

    @Test
    void anAbsentFileIsNoGoalAndNotAnError(@TempDir Path dir) {
        assertNull(GoalStore.read(dir.resolve("never-written.goal.md")));
    }

    @Test
    void theSessionIdIsFencedTheSameWayTheWireRecordersIs() {
        // LlmWireRecorder.fileFor keeps exactly this fence so a crafted id
        // cannot write a sidecar into another directory. A second sidecar with a
        // looser fence would be the hole.
        assertThrows(IllegalArgumentException.class, () -> GoalStore.fileFor("../../etc/passwd"));
        assertThrows(IllegalArgumentException.class, () -> GoalStore.fileFor(null));
        assertTrue(GoalStore.fileFor("20260819-101500").toString().endsWith(
                "20260819-101500.goal.md"));
    }

    @Test
    void aMultiLineOutcomeComesBackByteForByte(@TempDir Path dir) throws Exception {
        // Criterion 2 says the operator's words reach the model verbatim, and on
        // the browser face this file is where they come from. section() used to
        // strip EVERY line, so a list came back de-indented — a quiet rewrite of
        // the one thing the card promises not to rewrite.
        Path file = dir.resolve("s.goal.md");
        String outcome = "Ship it:\n\n  - the refresh case\n  - no threshold loosened";
        GoalStore.write(file, new RunGoal(outcome, "node --test test/auth.test.js"));

        RunGoal back = GoalStore.read(file);
        assertEquals(outcome, back.outcome());
        assertEquals("node --test test/auth.test.js", back.check());
    }

    @Test
    void aCheckWrittenAsAnIndentedBlockComesBackAsTheCommandItWas(@TempDir Path dir)
            throws Exception {
        // The check is the one section write() indents, so it is the one section
        // read() must de-indent. Pinned apart from the outcome, because "strip
        // everything" made both look right in a single-line test.
        Path file = dir.resolve("s.goal.md");
        Files.writeString(file, "## Outcome\n\nthe build is green\n\n"
                + "## Check\n\n    ./gradlew test \\\n    --rerun-tasks\n");
        // EVERY line loses the code indent, not just the first — a one-line
        // check cannot tell "de-indent each line" from "strip the whole body",
        // so it pins nothing, and the first version of this test did not.
        assertEquals("./gradlew test \\\n--rerun-tasks", GoalStore.read(file).check());
    }
}
