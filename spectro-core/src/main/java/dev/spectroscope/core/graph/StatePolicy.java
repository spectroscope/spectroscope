package dev.spectroscope.core.graph;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

/**
 * What a run is allowed to write into its {@code .state.jsonl}, decided once and
 * carried unchanged to every node.
 *
 * <p>Recording values is OFF unless the caller says otherwise in one visible line
 * of its own source. A library upgrade that quietly began writing a user's
 * document corpus to disk would be a data incident, not a feature, so there is no
 * ambient default that turns it on and {@link #full(boolean)} cannot be reached
 * by tab-completing a mode name.</p>
 *
 * <p>A policy is frozen for the length of a run. A tier that could change halfway
 * through would make the {@code state_policy} record — the one line that explains
 * why a channel is missing — a lie about the lines below it.</p>
 */
public final class StatePolicy {

    /** The four tiers, in the order of how much of the state they can reach. */
    public enum Mode {

        /** Nothing is recorded and nothing is built. */
        OFF("off"),

        /** Only channels named on the allow list are recorded. */
        SUMMARY("summary"),

        /** Everything not denied is recorded, subject to the caps. */
        SAMPLE("sample"),

        /** Everything not denied is recorded whole. */
        FULL("full");

        private final String wire;

        Mode(String wire) {
            this.wire = wire;
        }

        /** @return the lowercase token this mode is written as */
        public String wire() {
            return wire;
        }
    }

    /** A per-channel ceiling. Reaches the wire as an int or a three-element array. */
    public sealed interface Cap permits ByteCap, SampleCap {
    }

    /**
     * A byte ceiling for the strings of one channel.
     *
     * @param bytes the UTF-8 byte ceiling
     */
    public record ByteCap(int bytes) implements Cap {
    }

    /**
     * A ceiling that also cuts lists down to their leading elements.
     *
     * <p>It applies at EVERY depth of its channel: a nested tag list inside a kept
     * document is sampled by the same {@code keep}, and every string anywhere
     * under the channel is clipped at the same {@code bytes}. Applying it only at
     * the first level records far more than the policy promised.</p>
     *
     * @param keep  how many leading elements survive
     * @param bytes the UTF-8 byte ceiling for strings under this channel
     */
    public record SampleCap(int keep, int bytes) implements Cap {
    }

    /** The ceiling on a whole record, envelope included. */
    public static final int RECORD_CAP = 8192;

    /**
     * The channels {@code summary} records, in reading order — this is also the
     * order a panel shows them in, which is why it is a list and not a set.
     */
    public static final List<String> DEFAULT_ALLOW = List.of("question", "query_used", "route",
            "answer", "citations", "confidence", "abstained", "grade_ratio", "rewrites", "trace");

    /** Channels no tier records unless they are named on the allow list. */
    public static final List<String> DEFAULT_DENY = List.of("principal");

    /** The per-channel ceilings, in declaration order. {@code *} is the fallback. */
    public static final Map<String, Cap> DEFAULT_CAPS = defaultCaps();

    private final Mode mode;
    private final List<String> allowed;
    private final Map<String, Cap> caps;
    private final Integer recordCap;
    private final List<String> denied;
    private final String redaction;

    private StatePolicy(Mode mode, List<String> allowed, Map<String, Cap> caps, Integer recordCap,
                        List<String> denied, String redaction) {
        this.mode = mode;
        this.allowed = allowed;
        this.caps = caps;
        this.recordCap = recordCap;
        this.denied = denied;
        this.redaction = redaction;
    }

    private static Map<String, Cap> defaultCaps() {
        LinkedHashMap<String, Cap> caps = new LinkedHashMap<>();
        caps.put("answer", new ByteCap(16384));
        caps.put("question", new ByteCap(4096));
        caps.put("query_used", new ByteCap(4096));
        caps.put("trace", new ByteCap(8192));
        caps.put("citations", new SampleCap(8, 1024));
        caps.put("docs", new SampleCap(3, 512));
        caps.put("*", new ByteCap(1024));
        return Collections.unmodifiableMap(caps);
    }

    // -- the four tiers ----------------------------------------------------- //

    /**
     * @return the default: nothing is recorded, and nothing is even built
     */
    public static StatePolicy off() {
        return new StatePolicy(Mode.OFF, List.of(), Map.of(), null, List.of(), "off");
    }

    /**
     * The named-channels tier, whose promise is "no documents".
     *
     * <p>A caller whose state uses different words gets nothing until it says
     * which words. That is the safe way round for a mode that has to be able to
     * promise a corpus never reached the file.</p>
     *
     * @return a policy recording only {@link #DEFAULT_ALLOW}
     */
    public static StatePolicy summary() {
        return new StatePolicy(Mode.SUMMARY, DEFAULT_ALLOW, DEFAULT_CAPS, RECORD_CAP,
                DEFAULT_DENY, "patterns");
    }

    /**
     * @return a policy recording every channel that is not denied, cut to the caps
     */
    public static StatePolicy sample() {
        return new StatePolicy(Mode.SAMPLE, List.of(), DEFAULT_CAPS, RECORD_CAP,
                DEFAULT_DENY, "patterns");
    }

    /**
     * Everything not denied, uncapped.
     *
     * <p>The argument is not ceremony. This tier measures over 100 % of the state
     * it observes, so a caller who arrived here without deciding to has not made
     * the decision the mode represents.</p>
     *
     * @param acknowledged the caller's explicit acknowledgement
     * @return the uncapped policy
     * @throws GraphValidationException when the acknowledgement is absent
     */
    public static StatePolicy full(boolean acknowledged) {
        if (!acknowledged) {
            throw new GraphValidationException("StatePolicy.full records every channel a node "
                    + "writes, uncapped, into a file on disk. Pass full(true) to say so.");
        }
        return new StatePolicy(Mode.FULL, List.of(), Map.of(), null, DEFAULT_DENY, "patterns");
    }

    // -- narrowing ---------------------------------------------------------- //

    /**
     * @param channels the channels recorded whatever else says
     * @return a copy carrying that allow list
     */
    public StatePolicy withAllowed(List<String> channels) {
        return new StatePolicy(mode, List.copyOf(channels), caps, recordCap, denied, redaction);
    }

    /**
     * @param channels the channels never recorded
     * @return a copy carrying that deny list
     */
    public StatePolicy withDenied(List<String> channels) {
        return new StatePolicy(mode, allowed, caps, recordCap, List.copyOf(channels), redaction);
    }

    /**
     * A cap of {@code null} denies its channel outright: it leaves {@code caps}
     * entirely and joins {@code denied}, because a denied channel shown with a cap
     * would read as recordable.
     *
     * @param table the per-channel ceilings, in the order they should be written
     * @return a copy carrying that cap table
     */
    public StatePolicy withCaps(Map<String, Cap> table) {
        LinkedHashMap<String, Cap> kept = new LinkedHashMap<>();
        LinkedHashSet<String> refused = new LinkedHashSet<>(denied);
        table.forEach((channel, cap) -> {
            if (cap == null) {
                refused.add(channel);
            } else {
                kept.put(channel, cap);
            }
        });
        return new StatePolicy(mode, allowed, Collections.unmodifiableMap(kept), recordCap,
                List.copyOf(refused), redaction);
    }

    /**
     * @param cap the whole-record ceiling, or {@code null} for none
     * @return a copy carrying that record cap
     */
    public StatePolicy withRecordCap(Integer cap) {
        return new StatePolicy(mode, allowed, caps, cap, denied, redaction);
    }

    // -- reading ------------------------------------------------------------ //

    /** @return the tier */
    public Mode mode() {
        return mode;
    }

    /** @return the channels recorded regardless of the deny list */
    public List<String> allowed() {
        return allowed;
    }

    /** @return the per-channel ceilings, in wire order */
    public Map<String, Cap> caps() {
        return caps;
    }

    /** @return the whole-record ceiling, or {@code null} */
    public Integer recordCap() {
        return recordCap;
    }

    /** @return the channels never recorded */
    public List<String> denied() {
        return denied;
    }

    /**
     * @return {@code "patterns"} or {@code "off"} — a STRING, never a boolean.
     *         {@code true} would claim a completeness the measurement disproves:
     *         credential shapes are caught, confidential prose is not, and a RAG
     *         corpus is made of prose.
     */
    public String redaction() {
        return redaction;
    }

    /** @return whether this policy records anything at all */
    public boolean enabled() {
        return mode != Mode.OFF;
    }

    /**
     * The one gate, asked once per channel, so the record and the policy line that
     * explains it cannot give two answers.
     *
     * @param channel the channel a node wrote
     * @return whether it may be recorded; allowed beats denied beats the mode
     */
    public boolean recordsChannel(String channel) {
        if (allowed.contains(channel)) {
            return true;
        }
        if (denied.contains(channel)) {
            return false;
        }
        return mode == Mode.SAMPLE || mode == Mode.FULL;
    }

    /**
     * @param channel the channel a node wrote
     * @return its ceiling, the {@code *} fallback, or {@code null} when uncapped
     */
    public Cap capFor(String channel) {
        Cap named = caps.get(channel);
        return named != null ? named : caps.get("*");
    }

    @Override
    public String toString() {
        return "StatePolicy[" + mode.wire() + "]";
    }
}
