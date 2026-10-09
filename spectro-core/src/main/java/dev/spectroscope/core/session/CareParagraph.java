package dev.spectroscope.core.session;

import dev.spectroscope.core.config.governing.Governs;

/**
 * Card 492: the care paragraph, a short request at the end of the system
 * prompt to work in small steps on a backend with little capacity.
 *
 * <p>The text names no backend. The concept's wording began "This chat runs
 * on a local model"; the key reaches a hosted chat too, so that clause is
 * left out.</p>
 *
 * <p>The model may ignore it. What a run may do is held by the enforced
 * settings (tool groups, and later the session count and the read share);
 * this paragraph only asks. It is built once per run, so its text does not
 * change within a run and a cached prompt prefix stays valid.</p>
 */
public final class CareParagraph {

    /** What sits between the system prompt and the paragraph. */
    public static final String SEPARATOR = "\n\n";

    /** The helpers an agent's paragraph names until a face hands it a count
     *  through {@link #helpersFor}: the concept's default of three model
     *  sessions per chat, the main agent and two helpers
     *  ({@code konzept/RUN-PROFILES.md}, Knobs). The owner named three
     *  sessions; nobody has measured how many requests the house test backend
     *  serves at once usefully. */
    @Governs(kind = Governs.Kind.UNEXAMINED, unit = Governs.Unit.COUNT)
    public static final int DEFAULT_HELPERS = 2;

    private CareParagraph() {
    }

    /**
     * How many helpers the paragraph names for these settings. Every face that
     * offers a spawn tool takes the count from here, so the chat's session
     * count reaches the paragraph through one method.
     *
     * <p>The count is the chat's {@code sessionsPerChat} (card 490) minus the
     * main agent's own session. While the key is unset the paragraph names
     * {@code DEFAULT_SESSIONS_PER_CHAT - 1}, the proposed count's helpers.
     * {@code CareHelperWiringDriftTest} fails in a tree where the config
     * declares the key and this method does not read it.</p>
     *
     * @param config the settings as the face reads them now
     * @return the subagents that may run at once, at least 1
     */
    public static int helpersFor(dev.spectroscope.core.config.SpectroConfig config) {
        return helpersFor(config.sessionsPerChat());
    }

    /**
     * The same count for a session count a face holds itself, the way the
     * browser session holds the one the Local mode switch wrote (card 493).
     *
     * @param sessionsPerChat the chat's count, or null when none is set
     * @return the helpers the paragraph names
     */
    public static int helpersFor(Integer sessionsPerChat) {
        int sessions = sessionsPerChat != null ? sessionsPerChat
                : dev.spectroscope.core.config.SpectroConfig.DEFAULT_SESSIONS_PER_CHAT;
        return sessions - 1;
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
        return "This chat runs with limited capacity, so every request takes time."
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
