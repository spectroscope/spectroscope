package dev.spectroscope.core.loop;

import dev.spectroscope.core.config.governing.Governs;

/**
 * The numbers of a loop (card 504, concept AGENT-MESSAGING section Loop).
 * Each is a governed row in {@code numbers.json}; they are Claude Code's
 * dynamic loop bounds as reader 02 measured them.
 */
public final class LoopLimits {

    private LoopLimits() {
    }

    /** The shortest delay a wakeup may have; a shorter one is raised to it. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    public static final int MIN_DELAY_SECONDS = 60;

    /** The longest delay a wakeup may have; a longer one is cut to it. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    public static final int MAX_DELAY_SECONDS = 3_600;

    /** The delay of the one fallback wakeup the harness arms when a tick ends without one. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    public static final int KEEPALIVE_SECONDS = 1_200;

    /** How long a loop lives from its start before it ends as {@code aged_out}: seven days. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long MAX_AGE_MS = 604_800_000L;

    /** Ticks in a row that may end without a wakeup before the loop ends as {@code model_stopped}. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int KEEPALIVE_MISSES = 1;

    /**
     * The longest reason and prompt {@code schedule_wakeup} takes from the
     * model, in characters (card 504 fix round 2): a longer reason is cut, a
     * longer prompt is refused. The same 500 as a child's status line
     * ({@code BackgroundRun.STATUS_LINE_CAP}).
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int TEXT_CAP = 500;
}
