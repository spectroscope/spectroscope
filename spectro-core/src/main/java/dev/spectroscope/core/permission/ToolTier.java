package dev.spectroscope.core.permission;

import java.util.Locale;

/**
 * What a tool can DO, as opposed to what it is called. Three tiers, ordered by
 * blast radius, and the order is the whole point: an allowlist entry names a
 * ceiling, and a call passes only when the tool's own tier sits at or below it.
 *
 * <p>The gate before card 199 matched tool NAMES. A single wildcard written to
 * stop a prompt storm therefore approved everything a server offered — a
 * screenshot and a Node-context eval alike. Naming the tier is what lets a
 * wildcard mean "the readers, and nothing above them".
 *
 * <p>The ordinal is load-bearing: {@link #atMost} compares by it, so the
 * constants must stay in ascending blast-radius order. Adding a tier in the
 * middle changes every existing entry's meaning, which is why the wire name is
 * spelled out per constant rather than derived from {@link #name()}.
 */
public enum ToolTier {

    /** Looks, never touches: a page read, a console dump, a screenshot, a file read. */
    READ("read"),

    /** Acts on the page, the app or the disk: input, navigation, a file write. */
    WRITE("write"),

    /**
     * Runs code — in the page, in a Node context, or on this machine. Also the
     * tier every unmapped tool falls to, because a tool nobody rated is a tool
     * nobody vouched for.
     */
    EVAL_EXECUTE("eval-execute");

    private final String wireName;

    ToolTier(String wireName) {
        this.wireName = wireName;
    }

    /** The spelling used in the tier map, in an allowlist entry and in the audit trail. */
    public String wireName() {
        return wireName;
    }

    /**
     * Parses a tier as written in the map or in an allowlist entry.
     *
     * <p>Refuses rather than guesses: an unrecognized word must not silently
     * become a tier, because every wrong guess here is a widening. Callers turn
     * the null into an inert entry (allowlist) or a load failure (map).
     *
     * @param wireName the tier word, case-insensitive, may be null
     * @return the tier, or null when the word names none
     */
    public static ToolTier parse(String wireName) {
        if (wireName == null) {
            return null;
        }
        String normalized = wireName.strip().toLowerCase(Locale.ROOT);
        for (ToolTier tier : values()) {
            if (tier.wireName.equals(normalized)) {
                return tier;
            }
        }
        return null;
    }

    /**
     * Whether this tier fits under a ceiling — the gate's whole comparison.
     *
     * @param ceiling the tier an allowlist entry named
     * @return true when this tier is no wider than the ceiling
     */
    public boolean atMost(ToolTier ceiling) {
        return ordinal() <= ceiling.ordinal();
    }

    /**
     * The wider of two tiers. The ONE direction a hint from outside the product
     * may move a tool: a wire annotation, a second source, anything not the
     * shipped map may raise a tool above its mapped tier and never lower it.
     *
     * @param other the other tier; null is treated as no opinion
     * @return whichever of the two has the larger blast radius
     */
    public ToolTier widest(ToolTier other) {
        if (other == null) {
            return this;
        }
        return ordinal() >= other.ordinal() ? this : other;
    }
}
