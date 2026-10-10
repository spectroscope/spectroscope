package dev.spectroscope.core.subagents;

import dev.spectroscope.core.config.SettingFloors;

/**
 * How many model sessions one chat may run at once, and every number the
 * spawn tools derive from it (card 490).
 *
 * <p>This is the one source. The description of {@code spawn_agent} and
 * {@code spawn_agents}, the {@code maxItems} of the {@code spawn_agents}
 * schema, the width check that refuses a larger batch, the chat's slot pool
 * and the queue allowance of {@link ChildBudget#firstTokenGraceMs(SessionCount)}
 * all read an instance of this record. {@code SessionCountDriftTest} holds the
 * four readers to it.</p>
 *
 * <p>The count covers the main agent and its helpers together. The main
 * agent holds one session for as long as the chat runs, so a chat at 3 runs
 * two helpers at a time and the third waits for a free slot.</p>
 *
 * <p>Unset is the v0.14.4 behaviour: no limit per chat, and one
 * {@code spawn_agents} call starts up to
 * {@link SubagentManager#MAX_PARALLEL_CHILDREN} helpers. The descriptions and
 * the schema are then the v0.14.4 bytes.</p>
 *
 * @param sessions the chat's count, or null when none is set
 */
public record SessionCount(Integer sessions) {

    /** No count set: the v0.14.4 behaviour. */
    public static final SessionCount UNSET = new SessionCount(null);

    /** The settings key this count is read from. */
    public static final String KEY = "sessionsPerChat";

    /**
     * Refuses a count below the floor {@link SettingFloors} holds for
     * {@value #KEY}. The settings path never brings one here (the writer
     * refuses it and the loader skips it); code that builds a config with its
     * own number gets the key's name.
     *
     * @param sessions the chat's count, or null when none is set
     * @throws IllegalArgumentException when the count is below the floor
     */
    public SessionCount {
        if (sessions != null && sessions < floor()) {
            throw new IllegalArgumentException(
                    KEY + " must be at least " + floor() + ", got " + sessions);
        }
    }

    /**
     * @param sessions the chat's count, or null when none is set
     * @return {@link #UNSET} for null, else a count
     */
    public static SessionCount of(Integer sessions) {
        return sessions == null ? UNSET : new SessionCount(sessions);
    }

    /** The lowest count a chat may hold: 2, the main agent and one helper.
     *  A count of 1 would be a second way to say "no helpers", which the
     *  {@code agents} tool group already says (card 466).
     *  @return the floor {@link SettingFloors} holds for {@value #KEY} */
    public static int floor() {
        Integer floor = SettingFloors.floors().get(KEY);
        if (floor == null) {
            throw new IllegalStateException("SettingFloors has no floor for " + KEY);
        }
        return floor;
    }

    /** @return whether the chat has a count of its own */
    public boolean isSet() {
        return sessions != null;
    }

    /**
     * How many helpers of the chat may run at the same time.
     *
     * @return the count minus the main agent's session; unset, the width of one
     *         {@code spawn_agents} call, which is what v0.14.4 started at once
     */
    public int helpersAtOnce() {
        return sessions == null ? SubagentManager.MAX_PARALLEL_CHILDREN : sessions - 1;
    }

    /**
     * How many helpers one {@code spawn_agents} call may ask for: the schema's
     * {@code maxItems} and the width check. It never drops below
     * {@link SubagentManager#MAX_PARALLEL_CHILDREN}, because a batch wider than
     * the pool still runs; its tail waits for slots. It rises above it when the
     * chat allows more helpers at once than that, so the count can be used.
     *
     * @return the widest batch one call may carry
     */
    public int batchWidth() {
        return Math.max(SubagentManager.MAX_PARALLEL_CHILDREN, helpersAtOnce());
    }

    /**
     * How many other helpers of the chat can be in front of a helper at the
     * model server once it holds a slot. The queue allowance of the first-token
     * grace is this many median exchanges.
     *
     * @return {@link #helpersAtOnce()} minus the helper itself
     */
    public int queuedAhead() {
        return helpersAtOnce() - 1;
    }

    /**
     * The sentence the spawn tools append when a count is set (card 490,
     * criterion 6). Empty when none is set, so the v0.14.4 descriptions stay
     * byte for byte.
     *
     * @return the sentence with a leading space, or the empty string
     */
    public String limitSentence() {
        if (sessions == null) {
            return "";
        }
        int helpers = helpersAtOnce();
        return helpers == 1
                ? " In this chat at most 1 subagent runs at a time; further ones wait for a free slot."
                : " In this chat at most " + helpers
                        + " subagents run at the same time; further ones wait for a free slot.";
    }

    /**
     * What the chat shows for a helper that waits for a slot (card 490,
     * criterion 4). It rides an existing {@code agent_message} with role
     * {@code status} and the A2A state {@code submitted}.
     *
     * @return one sentence naming the limit the helper waits behind
     */
    public String waitingText() {
        int helpers = helpersAtOnce();
        return "Waiting for a free slot: this chat runs at most " + helpers
                + (helpers == 1 ? " subagent" : " subagents") + " at the same time.";
    }
}
