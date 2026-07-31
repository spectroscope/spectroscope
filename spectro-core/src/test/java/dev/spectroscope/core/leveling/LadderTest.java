package dev.spectroscope.core.leveling;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ladder is data, not code: {@code leveling/levels.json} in core resources
 * is the single source for engine, web, doctor and any generated poster. This
 * test is the schema — it fails the build the moment the file and the concept
 * (konzept/LEVELING.md §2) drift apart, which is the whole point of having one
 * source instead of four copies.
 */
class LadderTest {

    @Test
    void loadsTheBundledLadder() {
        Ladder ladder = Ladder.bundled();
        assertNotNull(ladder);
        assertEquals(1, ladder.schemaVersion());
    }

    @Test
    void hasTheSevenStatesInOrder() {
        List<Ladder.Level> levels = Ladder.bundled().levels();
        assertEquals(7, levels.size());
        assertEquals(
                List.of("dark-frame", "first-light", "the-trace", "the-gate",
                        "the-prism", "the-fleet", "deep-field"),
                levels.stream().map(Ladder.Level::id).toList());
        for (int i = 0; i < levels.size(); i++) {
            assertEquals(i, levels.get(i).index(), "level indices are dense and ordered");
        }
    }

    @Test
    void hasEveryCriterionFromTheConcept() {
        Set<String> ids = Ladder.bundled().criteria().stream()
                .map(Ladder.Criterion::id).collect(Collectors.toSet());
        assertEquals(Set.of(
                "provider-ready",
                "first-run-complete", "session-reopened",
                "trace-opened", "replay-scrubbed", "disclosure-expanded",
                "mode-set", "gate-answered",
                "fanout-watched", "lens-used", "lab-stepped",
                "fleet-entered", "machine-room-opened",
                "explain-run", "otlp-probe-green", "session-imported",
                "starter-scaffolded", "fleet-acted"), ids);
    }

    @Test
    void everyAdvanceCriterionExistsAndSitsOnItsOwnLevel() {
        Ladder ladder = Ladder.bundled();
        for (Ladder.Level level : ladder.levels()) {
            for (String criterionId : level.advanceWhen()) {
                Ladder.Criterion c = ladder.criterion(criterionId);
                assertNotNull(c, "level " + level.id() + " advances on unknown criterion " + criterionId);
                assertEquals(level.index(), c.level(),
                        criterionId + " must belong to the level it advances");
                assertFalse(c.mastery(), criterionId + " gates a level, so it cannot be mastery-only");
            }
        }
    }

    @Test
    void theTopLevelAdvancesNowhereAndCarriesTheMasteryCriteria() {
        Ladder ladder = Ladder.bundled();
        Ladder.Level deepField = ladder.levels().get(6);
        assertTrue(deepField.advanceWhen().isEmpty(), "nothing locks behind the top of the ladder");
        List<Ladder.Criterion> mastery = ladder.criteria().stream()
                .filter(Ladder.Criterion::mastery).toList();
        assertEquals(5, mastery.size());
        assertTrue(mastery.stream().allMatch(c -> c.level() == 6));
    }

    @Test
    void everyCriterionCarriesCopyKeysAndNoCopy() {
        for (Ladder.Criterion c : Ladder.bundled().criteria()) {
            assertTrue(c.labelKey().startsWith("leveling."), c.id() + " needs an i18n key, not a string");
            assertTrue(c.countsKey().startsWith("leveling."), c.id() + " needs a 'what counts' key");
        }
        for (Ladder.Level l : Ladder.bundled().levels()) {
            assertTrue(l.nameKey().startsWith("leveling."), l.id() + " needs an i18n key");
            assertTrue(l.blurbKey().startsWith("leveling."), l.id() + " needs a blurb key");
        }
    }

    @Test
    void beaconCriteriaNameTheSurfaceTheyListenFor() {
        for (Ladder.Criterion c : Ladder.bundled().criteria()) {
            if (c.source() == Ladder.Source.BEACON || c.source() == Ladder.Source.JOINED) {
                assertNotNull(c.surface(), c.id() + " arrives as a beacon and must name its surface");
                assertFalse(c.surface().isBlank());
            }
        }
    }

    @Test
    void surfacesOpenExactlyOnce() {
        List<String> all = Ladder.bundled().levels().stream()
                .flatMap(l -> l.opens().stream()).toList();
        assertEquals(all.size(), Set.copyOf(all).size(), "a surface opens at exactly one level");
    }
}
