package dev.spectroscope.core.subagents;

import java.util.Arrays;
import java.util.Optional;

/**
 * The child-agent profiles. The lowercase id is the agentId
 * prefix ("explore-1", "worker-2") and, for the spawnable pair, the wire value
 * in the spawn tools' input schema — it must match the TypeScript edition byte
 * for byte.
 */
public enum AgentType {
    EXPLORE("explore", true),
    WORKER("worker", true),
    /**
     * Card 205: read tools plus the session's web tools — started only through
     * the {@code research} role tool, never through spawn_agent, so the spawn
     * schema's enum stays {@code explore|worker}. Its web calls pass the same
     * permission gate as the parent's: the role grants reach, and the card-199
     * tiers keep deciding each call.
     */
    RESEARCH("research", false);

    private final String id;
    private final boolean spawnable;

    /**
     * Binds the profile to its fixed wire id.
     *
     * @param id        lowercase wire name, byte-for-byte stable on the wire
     * @param spawnable whether the spawn tools may start this type directly
     */
    AgentType(String id, boolean spawnable) {
        this.id = id;
        this.spawnable = spawnable;
    }

    /** Lowercase wire name, e.g. "explore". */
    public String id() {
        return id;
    }

    /** True when spawn_agent/spawn_agents may start this type directly —
     *  role-only types (research) are refused there like any unknown string. */
    public boolean spawnable() {
        return spawnable;
    }

    /**
     * Parses the wire value from a tool input. Empty for unknown values — the
     * caller reports that as an "ERROR: " tool-result string (tool inputs are
     * model output and therefore untrusted).
     *
     * @param value the raw type string from the model's tool input
     * @return the matching profile, or empty for anything unrecognized
     */
    public static Optional<AgentType> fromId(String value) {
        return Arrays.stream(values())
                .filter(type -> type.id.equals(value))
                .findFirst();
    }
}
