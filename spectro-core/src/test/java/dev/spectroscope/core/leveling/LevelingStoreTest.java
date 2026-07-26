package dev.spectroscope.core.leveling;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The store is the only mutable thing in the wave, so it carries the house
 * discipline for home files: written atomically, owner-only, and never able to
 * take a run down with it. A leveling file that cannot be read is a leveling
 * file that gets rebuilt, not an exception on a user's first morning.
 */
class LevelingStoreTest {

    private static LevelingState sample() {
        return new LevelingState(
                LevelingState.Mode.LADDER,
                Map.of("first-run-complete",
                        new LevelingState.Mark("first-run-complete", "20260726-aaa", 7, 1000L,
                                LevelingState.Origin.OBSERVED),
                        "lens-used",
                        new LevelingState.Mark("lens-used", null, null, 2000L,
                                LevelingState.Origin.MANUAL)),
                List.of(new LevelingState.LevelUp(1, 1000L)),
                Map.of("20260726-aaa", LevelingState.SessionFacts.of(true, Set.of("main", "worker"))));
    }

    @Test
    void writesAndReadsBackEveryField(@TempDir Path dir) throws IOException {
        LevelingStore store = new LevelingStore(dir.resolve("leveling.json"));
        store.write(sample());

        LevelingState back = store.read().orElseThrow();
        assertEquals(LevelingState.Mode.LADDER, back.mode());
        assertEquals(2, back.marks().size());
        LevelingState.Mark observed = back.marks().get("first-run-complete");
        assertEquals("20260726-aaa", observed.sessionId());
        assertEquals(7, observed.eventIndex().intValue());
        assertEquals(LevelingState.Origin.OBSERVED, observed.origin());
        assertEquals(LevelingState.Origin.MANUAL, back.marks().get("lens-used").origin(),
                "a hand tick stays a hand tick across a restart");
        assertEquals(1, back.history().size());
        assertTrue(back.facts().get("20260726-aaa").fannedOut());
    }

    @Test
    void aMissingFileIsAFreshHomeNotAnError(@TempDir Path dir) {
        LevelingStore store = new LevelingStore(dir.resolve("nothing-here.json"));
        assertEquals(Optional.empty(), store.read());
    }

    @Test
    void aCorruptFileIsRebuiltNeverThrown(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("leveling.json");
        Files.writeString(file, "{ this is not json", StandardCharsets.UTF_8);
        LevelingStore store = new LevelingStore(file);
        assertEquals(Optional.empty(), store.read(), "unreadable state is no state, not a crash");
        store.write(LevelingState.fresh(LevelingState.Mode.CHECKLIST));
        assertEquals(LevelingState.Mode.CHECKLIST, store.read().orElseThrow().mode());
    }

    @Test
    void theFileIsOwnerOnly(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("leveling.json");
        new LevelingStore(file).write(sample());
        Set<PosixFilePermission> perms = Files.getPosixFilePermissions(file);
        assertEquals(Set.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE), perms,
                "the ladder records what an operator did; it is nobody else's business");
    }

    @Test
    void writingLeavesNoTemporaryFilesBehind(@TempDir Path dir) throws IOException {
        LevelingStore store = new LevelingStore(dir.resolve("leveling.json"));
        store.write(sample());
        store.write(sample());
        try (var entries = Files.list(dir)) {
            List<String> names = entries.map(p -> p.getFileName().toString()).toList();
            assertEquals(List.of("leveling.json"), names, "atomic means tmp + move, and the tmp is gone");
        }
    }

    @Test
    void aRewriteReplacesRatherThanAppends(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("leveling.json");
        LevelingStore store = new LevelingStore(file);
        store.write(sample());
        store.write(LevelingState.fresh(LevelingState.Mode.OFF));
        LevelingState back = store.read().orElseThrow();
        assertEquals(LevelingState.Mode.OFF, back.mode());
        assertTrue(back.marks().isEmpty());
    }

    @Test
    void unknownFieldsInTheFileSurviveARead(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("leveling.json");
        Files.writeString(file, """
                {"mode":"ladder","marks":{},"history":[],"facts":{},"futureField":"from a newer build"}
                """, StandardCharsets.UTF_8);
        assertEquals(LevelingState.Mode.LADDER, new LevelingStore(file).read().orElseThrow().mode(),
                "a newer build's file must not brick an older one");
    }

    @Test
    void anUnreadableModeFallsBackToTheModeThatLocksNothing(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("leveling.json");
        Files.writeString(file, """
                {"mode":"sideways","marks":{},"history":[],"facts":{}}
                """, StandardCharsets.UTF_8);
        assertEquals(LevelingState.Mode.CHECKLIST, new LevelingStore(file).read().orElseThrow().mode(),
                "when in doubt, never lock a home out of its own surfaces");
    }

    @Test
    void theFileIsReadableJsonWithLowercaseWireNames(@TempDir Path dir) throws IOException {
        Path file = dir.resolve("leveling.json");
        new LevelingStore(file).write(sample());
        String text = Files.readString(file, StandardCharsets.UTF_8);
        assertTrue(text.contains("\"mode\" : \"ladder\""), "modes are lowercase on the wire:\n" + text);
        assertTrue(text.contains("\"observed\""), "origins are lowercase on the wire:\n" + text);
        assertFalse(text.contains("LADDER"), "no Java enum spelling leaks into the file");
    }
}
