package dev.spectroscope.core.leveling;

import dev.spectroscope.core.events.RunEvent;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * The pure heart of the ladder: evidence in, marks out. No I/O, no clock, no
 * policy — every timestamp comes from the evidence itself, so replaying the
 * same input always produces the same state.
 *
 * <p>Three ways in, and the difference between them is the honesty of the
 * receipt. {@link #observe} folds the live event stream of a run in this home.
 * {@link #visit} takes a beacon from a face for the acts the stream never sees
 * (a tab opened, a scrubber moved). {@link #tick} is the hand tick from the
 * settings, and it is recorded as {@link LevelingState.Origin#MANUAL} forever
 * after, because a ladder that cannot tell what it saw from what it was told
 * is decoration.</p>
 *
 * <p>Two rules keep it from lying. Marks are write-once, so a replayed or
 * re-imported stream cannot double-credit and cannot overwrite the receipt of
 * the run that actually earned it. And a joined criterion needs both halves:
 * the beacon that says the operator looked, and the session's own stream
 * saying there was something to look at.</p>
 */
public final class LevelingFold {

    /**
     * How many sessions the fold keeps bookkeeping for. Two booleans per
     * session, dropped entirely once no join needs them; the cap only bounds
     * the pathological case of a home that never opens a trace.
     */
    public static final int MAX_TRACKED_SESSIONS = 200;

    /**
     * Stop reasons that mean the run came through. Everything else — an abort,
     * an error, and above all the in-band stream sentinels — is not a finished
     * run and must never light up first light.
     */
    private static final Set<String> COMPLETED_RUN = Set.of(
            "end_turn", "max_tokens", "max_turns", "tool_use");

    private LevelingFold() {
    }

    /**
     * Folds one event of a LIVE run in this home.
     *
     * <p>Liveness is structural, not guessed: this method is only ever reached
     * through a {@code TracingPort}, and imports and scenario replays never
     * touch that pipeline, so an imported transcript cannot mark anything here.</p>
     *
     * @param ladder the ladder in force
     * @param state the state before
     * @param sessionId the session this event belongs to, from the store, never from the event
     * @param eventIndex the position of this event in that session
     * @param event the event
     * @return the state after, or the same instance when nothing changed
     */
    public static LevelingState observe(Ladder ladder, LevelingState state,
                                        String sessionId, int eventIndex, RunEvent event) {
        Objects.requireNonNull(ladder, "ladder");
        Objects.requireNonNull(state, "state");
        Objects.requireNonNull(event, "event");
        if (state.mode() == LevelingState.Mode.OFF) {
            return state;
        }
        LevelingState next = rememberFacts(ladder, state, sessionId, event);
        if (event instanceof RunEvent.RunEnd end && COMPLETED_RUN.contains(end.stopReason())) {
            next = mark(ladder, next, "first-run-complete",
                    new LevelingState.Mark("first-run-complete", sessionId, eventIndex,
                            end.ts(), LevelingState.Origin.OBSERVED));
        }
        return next;
    }

    /**
     * Records that a face showed a surface, which is how the acts the event
     * stream cannot see reach the ladder.
     *
     * @param ladder the ladder in force
     * @param state the state before
     * @param surface the surface id the face reports
     * @param sessionId the session on screen, used to join with stream facts, may be null
     * @param ts when it happened, in epoch millis
     * @return the state after, or the same instance when the surface gates nothing
     */
    public static LevelingState visit(Ladder ladder, LevelingState state,
                                      String surface, String sessionId, long ts) {
        Objects.requireNonNull(ladder, "ladder");
        Objects.requireNonNull(state, "state");
        if (state.mode() == LevelingState.Mode.OFF || surface == null) {
            return state;
        }
        LevelingState next = state;
        for (Ladder.Criterion criterion : ladder.criteria()) {
            if (!surface.equals(criterion.surface())) {
                continue;
            }
            if (criterion.source() == Ladder.Source.JOINED && !streamAgrees(next, sessionId, criterion)) {
                continue;
            }
            next = mark(ladder, next, criterion.id(),
                    new LevelingState.Mark(criterion.id(), sessionId, null, ts,
                            LevelingState.Origin.OBSERVED));
        }
        return next == state ? state : forgetSettledFacts(ladder, next);
    }

    /**
     * Marks a criterion by hand, from the settings.
     *
     * @param ladder the ladder in force
     * @param state the state before
     * @param criterionId the criterion to tick
     * @param ts when the operator ticked it
     * @return the state after, or the same instance for an unknown or already-met criterion
     */
    public static LevelingState tick(Ladder ladder, LevelingState state, String criterionId, long ts) {
        Objects.requireNonNull(ladder, "ladder");
        Objects.requireNonNull(state, "state");
        if (state.mode() == LevelingState.Mode.OFF || ladder.criterion(criterionId) == null) {
            return state;
        }
        return mark(ladder, state, criterionId,
                new LevelingState.Mark(criterionId, null, null, ts, LevelingState.Origin.MANUAL));
    }

    /**
     * Marks a criterion the server established for itself, such as a provider
     * reporting ready or an OTLP probe answering.
     *
     * @param ladder the ladder in force
     * @param state the state before
     * @param criterionId the criterion the server can vouch for
     * @param ts when it was established
     * @return the state after, or the same instance when it is not a state criterion or already met
     */
    public static LevelingState establish(Ladder ladder, LevelingState state, String criterionId, long ts) {
        Objects.requireNonNull(ladder, "ladder");
        Objects.requireNonNull(state, "state");
        Ladder.Criterion criterion = ladder.criterion(criterionId);
        if (state.mode() == LevelingState.Mode.OFF
                || criterion == null || criterion.source() != Ladder.Source.STATE) {
            return state;
        }
        return mark(ladder, state, criterionId,
                new LevelingState.Mark(criterionId, null, null, ts, LevelingState.Origin.OBSERVED));
    }

    /**
     * Wipes marks and history back to a fresh home, keeping the chosen mode:
     * the ladder restarts, the operator's decision about how it runs does not.
     *
     * @param state the state before
     * @return an empty state in the same mode
     */
    public static LevelingState reset(LevelingState state) {
        return LevelingState.fresh(Objects.requireNonNull(state, "state").mode());
    }

    // ── internals ──────────────────────────────────────────────────────────

    /** Write-once: the first evidence keeps the receipt, and history grows only on a real climb. */
    private static LevelingState mark(Ladder ladder, LevelingState state,
                                      String criterionId, LevelingState.Mark mark) {
        if (state.isMarked(criterionId)) {
            return state;
        }
        Map<String, LevelingState.Mark> marks = new LinkedHashMap<>(state.marks());
        marks.put(criterionId, mark);
        int before = state.level(ladder);
        int after = ladder.levelFor(marks.keySet());
        List<LevelingState.LevelUp> history = state.history();
        if (after > before) {
            List<LevelingState.LevelUp> grown = new ArrayList<>(history);
            for (int reached = before + 1; reached <= after; reached++) {
                grown.add(new LevelingState.LevelUp(reached, mark.ts()));
            }
            history = grown;
        }
        return new LevelingState(state.mode(), marks, history, state.facts());
    }

    /** Bookkeeping for the joins: did this session run a tool, and how many agents did it carry. */
    private static LevelingState rememberFacts(Ladder ladder, LevelingState state,
                                               String sessionId, RunEvent event) {
        if (sessionId == null || !joinsStillOpen(ladder, state)) {
            return state;
        }
        boolean tool = event instanceof RunEvent.ToolCall;
        String introduced = introducedAgent(event);
        String parent = event instanceof RunEvent.AgentSpawn spawn ? spawn.parentId() : null;
        if (!tool && introduced == null && parent == null) {
            return state;
        }
        LevelingState.SessionFacts before = state.facts()
                .getOrDefault(sessionId, new LevelingState.SessionFacts(false, Set.of()));
        Set<String> agents = new LinkedHashSet<>(before.agents());
        if (introduced != null) {
            agents.add(introduced);
        }
        if (parent != null) {
            agents.add(parent);
        }
        LevelingState.SessionFacts after =
                new LevelingState.SessionFacts(before.toolCall() || tool, agents);
        if (after.equals(before)) {
            return state;
        }
        Map<String, LevelingState.SessionFacts> facts = new LinkedHashMap<>(state.facts());
        facts.remove(sessionId);            // re-insert so the cap evicts by last touch
        facts.put(sessionId, after);
        while (facts.size() > MAX_TRACKED_SESSIONS) {
            Iterator<String> oldest = facts.keySet().iterator();
            oldest.next();
            oldest.remove();
        }
        return new LevelingState(state.mode(), state.marks(), state.history(), facts);
    }

    /** The events that put an agent on the record; anything else merely mentions one. */
    private static String introducedAgent(RunEvent event) {
        return switch (event) {
            case RunEvent.RunStart start -> start.agentId();
            case RunEvent.AgentSpawn spawn -> spawn.agentId();
            default -> null;
        };
    }

    /** Whether the session behind a beacon shows what the joined criterion demands. */
    private static boolean streamAgrees(LevelingState state, String sessionId, Ladder.Criterion criterion) {
        if (sessionId == null) {
            return false;
        }
        LevelingState.SessionFacts facts = state.facts().get(sessionId);
        if (facts == null) {
            return false;
        }
        return switch (Objects.requireNonNullElse(criterion.requires(), "")) {
            case "tool-call" -> facts.toolCall();
            case "two-agents" -> facts.fannedOut();
            default -> false;
        };
    }

    private static boolean joinsStillOpen(Ladder ladder, LevelingState state) {
        return ladder.criteria().stream()
                .anyMatch(c -> c.source() == Ladder.Source.JOINED && !state.isMarked(c.id()));
    }

    /** Once every join is settled the per-session bookkeeping is dead weight, so it goes. */
    private static LevelingState forgetSettledFacts(Ladder ladder, LevelingState state) {
        if (joinsStillOpen(ladder, state) || state.facts().isEmpty()) {
            return state;
        }
        return new LevelingState(state.mode(), state.marks(), state.history(), Map.of());
    }

    /**
     * The criteria a home has yet to meet on its current rung, in ladder order.
     *
     * @param ladder the ladder in force
     * @param state the state to measure
     * @return the outstanding criterion ids, empty at the top of the ladder
     */
    public static List<String> remaining(Ladder ladder, LevelingState state) {
        int level = state.level(ladder);
        if (level >= ladder.levels().size()) {
            return List.of();
        }
        Set<String> marked = new HashSet<>(state.marks().keySet());
        return ladder.levels().get(level).advanceWhen().stream()
                .filter(id -> !marked.contains(id))
                .toList();
    }
}
