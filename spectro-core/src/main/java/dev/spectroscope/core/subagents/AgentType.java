package dev.spectroscope.core.subagents;

import java.util.Arrays;
import java.util.Optional;

/**
 * The two child-agent profiles. The lowercase id is the agentId
 * prefix ("explore-1", "worker-2") and the wire value in the spawn tools'
 * input schema — it must match the TypeScript edition byte for byte.
 */
public enum AgentType {
    EXPLORE("explore"),
    WORKER("worker");

    private final String id;

    /**
     * Binds the profile to its fixed wire id.
     *
     * @param id lowercase wire name, byte-for-byte stable on the wire
     */
    AgentType(String id) {
        this.id = id;
    }

    /** Lowercase wire name, e.g. "explore". */
    public String id() {
        return id;
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
