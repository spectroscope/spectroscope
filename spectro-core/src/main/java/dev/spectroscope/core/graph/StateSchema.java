package dev.spectroscope.core.graph;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * The channels a graph declares, and the merge that folds one node's update into
 * the state.
 *
 * <p>A declaration, never a gate. A node that writes a channel nobody declared
 * is merged, not refused: a run that died because a node stashed a diagnostic
 * field would be a worse failure than an untyped channel.</p>
 */
public final class StateSchema {

    private final Map<String, Channel> channels;

    private StateSchema(Map<String, Channel> channels) {
        this.channels = channels;
    }

    /**
     * @param channels the declared channels, in declaration order
     * @return the schema; an empty one is legitimate — every channel then
     *         overwrites, which is what a graph without reducers wants
     */
    public static StateSchema of(Channel... channels) {
        LinkedHashMap<String, Channel> declared = new LinkedHashMap<>();
        for (Channel channel : channels) {
            declared.put(channel.name(), channel);
        }
        return new StateSchema(declared);
    }

    /**
     * @param name the channel name
     * @return its declaration, or empty when the schema never named it
     */
    public Optional<Channel> channel(String name) {
        return Optional.ofNullable(channels.get(name));
    }

    /**
     * Folds one node's update into the state and returns a NEW state.
     *
     * <p>Never mutates either argument. The runtime keeps the pre-superstep
     * state alive to hand to every node in the frontier, and a checkpointer
     * keeps older snapshots alive to serve history — one in-place write would
     * corrupt both.</p>
     *
     * <p>A reducer needs a left operand. When the channel is absent — the normal
     * case on the first superstep — or when it holds {@code null}, the incoming
     * value SEEDS the channel instead of being folded into nothing. Channels are
     * folded in the update's own write order, which is why a node's write order
     * is preserved all the way from {@link StateUpdate} to here.</p>
     *
     * @param state  the state as it stood before this update
     * @param update the node's partial write, or {@code null} for "nothing changed"
     * @return a new state; never {@code state} itself, because a caller that
     *         held on to the result would otherwise share a map with the engine
     */
    public GraphState apply(GraphState state, StateUpdate update) {
        LinkedHashMap<String, Object> merged = new LinkedHashMap<>(state.values());
        if (update == null || update.isEmpty()) {
            return GraphState.adopt(merged);
        }
        update.channels().forEach((name, value) -> {
            Channel channel = channels.get(name);
            Object current = merged.get(name);
            if (channel == null || !channel.folds() || !merged.containsKey(name) || current == null) {
                merged.put(name, value);
            } else {
                merged.put(name, channel.fold(current, value));
            }
        });
        return GraphState.adopt(merged);
    }

    @Override
    public String toString() {
        return "StateSchema" + channels.keySet();
    }
}
