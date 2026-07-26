package dev.spectroscope.core.leveling;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * What this home has earned so far: the mode it runs in, one mark per met
 * criterion with the evidence behind it, the level-up history, and the session
 * bookkeeping the joined criteria need.
 *
 * <p>Immutable by construction; {@link LevelingFold} returns new instances.
 * This record is also the on-disk shape of {@code ~/.spectro/leveling.json},
 * so field names are wire names and evolution is additive only.</p>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record LevelingState(Mode mode,
                            Map<String, Mark> marks,
                            List<LevelUp> history,
                            Map<String, SessionFacts> facts) {

    /** How much of the ladder is doing work in this home. */
    public enum Mode {
        /** Surfaces beyond the current level render as teasers. Fresh homes only. */
        LADDER,
        /** Nothing locks; the pill and panel still track and celebrate. */
        CHECKLIST,
        /** No pill, no panel, no tracking, no writes. */
        OFF;

        /** @return the lowercase wire spelling, so the file reads like the concept */
        @com.fasterxml.jackson.annotation.JsonValue
        public String wire() {
            return name().toLowerCase(Locale.ROOT);
        }

        /** @param raw the lowercase wire spelling
         *  @return the constant, or {@link #CHECKLIST} for anything unrecognised, because a
         *          corrupt mode must never lock a home out of its own surfaces */
        @JsonCreator
        public static Mode fromJson(String raw) {
            if (raw == null) {
                return CHECKLIST;
            }
            try {
                return valueOf(raw.trim().toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException unknown) {
                return CHECKLIST;
            }
        }
    }

    /** Whether the engine saw the thing happen, or a hand said it did. */
    public enum Origin {
        /** Folded out of the event stream or reported by a face as it happened. */
        OBSERVED,
        /** Ticked by hand in the settings. Never dressed up as observation. */
        MANUAL;

        /** @return the lowercase wire spelling, so a receipt reads plainly */
        @com.fasterxml.jackson.annotation.JsonValue
        public String wire() {
            return name().toLowerCase(Locale.ROOT);
        }

        /** @param raw the lowercase wire spelling
         *  @return the constant, defaulting to {@link #MANUAL}: an unreadable receipt claims
         *          the weaker provenance, never the stronger one */
        @JsonCreator
        public static Origin fromJson(String raw) {
            if (raw == null) {
                return MANUAL;
            }
            try {
                return valueOf(raw.trim().toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException unknown) {
                return MANUAL;
            }
        }
    }

    /**
     * One met criterion and the receipt behind it.
     *
     * @param criterionId the criterion this marks
     * @param sessionId the session the evidence lives in, null for hand ticks and pure beacons
     * @param eventIndex the position in that session's stream, null when there is no event
     * @param ts when it was marked, in epoch millis, taken from the evidence not from a clock
     * @param origin observed or manual
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record Mark(String criterionId, String sessionId, Integer eventIndex, long ts, Origin origin) {
        /** @throws NullPointerException when the criterion or origin is missing */
        public Mark {
            Objects.requireNonNull(criterionId, "criterionId");
            Objects.requireNonNull(origin, "origin");
        }
    }

    /**
     * One rung reached.
     *
     * @param level the level index reached
     * @param ts when, in epoch millis
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record LevelUp(int level, long ts) {}

    /**
     * What a session's stream showed, kept only while a joined criterion still
     * needs it. Two facts, no payloads: this is bookkeeping, not a second store.
     *
     * @param toolCall the session ran at least one tool
     * @param agents the distinct agent ids seen in it
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record SessionFacts(boolean toolCall, Set<String> agents) {
        /** @param toolCall whether a tool call was seen
         *  @param agents the agent ids, copied defensively */
        public SessionFacts {
            agents = Set.copyOf(Objects.requireNonNullElse(agents, Set.of()));
        }

        /** @return true when this session showed a fan-out, which is two or more agents */
        public boolean fannedOut() {
            return agents.size() >= 2;
        }
    }

    /** @throws NullPointerException when the mode is missing */
    public LevelingState {
        Objects.requireNonNull(mode, "mode");
        marks = Map.copyOf(Objects.requireNonNullElse(marks, Map.of()));
        history = List.copyOf(Objects.requireNonNullElse(history, List.of()));
        facts = unmodifiableOrdered(Objects.requireNonNullElse(facts, Map.of()));
    }

    private static Map<String, SessionFacts> unmodifiableOrdered(Map<String, SessionFacts> source) {
        return java.util.Collections.unmodifiableMap(new LinkedHashMap<>(source));
    }

    /**
     * A home that has done nothing yet.
     *
     * @param mode the mode to start in
     * @return the empty state
     */
    public static LevelingState fresh(Mode mode) {
        return new LevelingState(mode, Map.of(), List.of(), Map.of());
    }

    /**
     * The rung this home stands on right now, computed from the marks alone so
     * that the stored level can never drift from the evidence.
     *
     * @param ladder the ladder to measure against
     * @return the level index
     */
    public int level(Ladder ladder) {
        return ladder.levelFor(marks.keySet());
    }

    /**
     * @param criterionId the criterion to check
     * @return true when this home has already met it
     */
    public boolean isMarked(String criterionId) {
        return marks.containsKey(criterionId);
    }
}
