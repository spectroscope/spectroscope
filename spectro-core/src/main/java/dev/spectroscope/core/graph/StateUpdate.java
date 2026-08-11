package dev.spectroscope.core.graph;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * One node's partial write: the channels it touched, in the order it touched
 * them. Never a whole state — a node returns what it changed and nothing else.
 *
 * <p>The python edition has to police this at run time, because a node there can
 * return anything: {@code []}, {@code ""}, {@code 0} and {@code false} are all
 * refused exactly as {@code ["x"]} is, since the TYPE is what is checked and
 * never the truthiness — a silent pass would hide the node's mistake until some
 * later run made the value non-empty. Here the type does that work at compile
 * time, and {@link #from(Object)} is the one seam where a value of unknown shape
 * can still arrive.</p>
 *
 * <p>{@code null} and {@link #none()} are the two ways to say "no channels
 * written". They are the same statement, not two.</p>
 */
public final class StateUpdate {

    private static final StateUpdate NONE = new StateUpdate(new LinkedHashMap<>());

    private final Map<String, Object> channels;

    private StateUpdate(LinkedHashMap<String, Object> owned) {
        this.channels = Collections.unmodifiableMap(owned);
    }

    /** The update of a node that changed nothing. */
    public static StateUpdate none() {
        return NONE;
    }

    /**
     * @param channel the channel to write
     * @param value   its new value, which may be {@code null}
     * @return an update carrying that one write
     */
    public static StateUpdate of(String channel, Object value) {
        LinkedHashMap<String, Object> written = new LinkedHashMap<>();
        written.put(channel, value);
        return new StateUpdate(written);
    }

    /**
     * @param channels the writes, in the order they should be folded
     * @return an update detached from the caller's map
     */
    public static StateUpdate ofMap(Map<String, ?> channels) {
        return new StateUpdate(new LinkedHashMap<>(channels));
    }

    /**
     * The dynamic seam: turns whatever a scripted or deserialized node produced
     * into an update, or refuses it by name.
     *
     * <p>Refusing here rather than at the fold is the point. A node that
     * returned an empty list said something wrong and happened to say it
     * emptily; letting it through would hide the mistake until a later run made
     * the value non-empty, in the one place a wrong answer is hardest to trace.</p>
     *
     * @param raw {@code null} for "nothing changed", or a map of channel writes
     * @return the update, or {@code null} when {@code raw} was {@code null}
     * @throws InvalidUpdateException for anything else, empty or not
     */
    public static StateUpdate from(Object raw) {
        if (raw == null) {
            return null;
        }
        if (raw instanceof StateUpdate update) {
            return update;
        }
        if (raw instanceof Map<?, ?> map) {
            LinkedHashMap<String, Object> written = new LinkedHashMap<>();
            map.forEach((key, value) -> written.put(String.valueOf(key), value));
            return new StateUpdate(written);
        }
        throw new InvalidUpdateException("Expected a map of channel updates, got "
                + raw.getClass().getSimpleName() + ": " + raw
                + ". A node returns its channel writes, or null for no change.");
    }

    /**
     * @param channel the next channel to write
     * @param value   its value
     * @return a new update with that write appended after the existing ones
     */
    public StateUpdate and(String channel, Object value) {
        LinkedHashMap<String, Object> written = new LinkedHashMap<>(channels);
        written.put(channel, value);
        return new StateUpdate(written);
    }

    /** The writes, in the node's OWN write order — never sorted. */
    public Map<String, Object> channels() {
        return channels;
    }

    /** Whether this update writes no channel at all. */
    public boolean isEmpty() {
        return channels.isEmpty();
    }

    @Override
    public String toString() {
        return "StateUpdate" + channels;
    }
}
