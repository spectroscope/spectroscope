package dev.spectroscope.core.session;

/**
 * Card 492: the care paragraph, a short request at the end of the system
 * prompt to work in small steps on a backend with little capacity.
 *
 * <p>The model may ignore it. What a run may do is held by the enforced
 * settings (tool groups, and later the session count and the read share);
 * this paragraph only asks. It is built once per run, so its text does not
 * change within a run and a cached prompt prefix stays valid.</p>
 */
public final class CareParagraph {

    /** What sits between the system prompt and the paragraph. */
    public static final String SEPARATOR = "\n\n";

    /** The helpers named when no session count reaches the agent: the
     *  concept's default of three model sessions per chat, the main agent
     *  and two helpers ({@code konzept/RUN-PROFILES.md}, Knobs). */
    public static final int DEFAULT_HELPERS = 2;

    private CareParagraph() {
    }

    /**
     * Whether a settings value turns the paragraph on. Unset means the
     * shipped value, off; only {@code "on"} turns it on.
     *
     * @param setting the {@code careParagraph} value, or null when unset
     * @return true only for {@code "on"}
     */
    public static boolean enabled(String setting) {
        return "on".equals(setting);
    }

    /**
     * The paragraph's text.
     *
     * @param helpers   how many subagents may run at once
     * @param subagents whether the run offers a spawn tool; without one the
     *                  sentence about subagents is left out
     * @return the paragraph, without a separator
     */
    public static String text(int helpers, boolean subagents) {
        String subagentSentence = subagents
                ? " Start at most " + helpers + " subagents at once; more wait for a free slot."
                : "";
        return "This chat runs on a local model with limited capacity, so every request takes time."
                + " Work in small steps."
                + " Read only the file you need next, and read large files in parts with offset and limit."
                + " Do not list or search the whole workspace in one call."
                + subagentSentence
                + " Check each result before the next step."
                + " Keep answers short.";
    }

    /**
     * What a run appends to its system prompt: the separator and the
     * paragraph when the setting is on, nothing when it is off.
     *
     * @param setting   the {@code careParagraph} value, or null when unset
     * @param helpers   how many subagents may run at once
     * @param subagents whether the run offers a spawn tool
     * @return the suffix, empty when the setting is off
     */
    public static String suffix(String setting, int helpers, boolean subagents) {
        return enabled(setting) ? SEPARATOR + text(helpers, subagents) : "";
    }
}
