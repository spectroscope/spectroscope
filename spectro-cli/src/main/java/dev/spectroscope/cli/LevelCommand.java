package dev.spectroscope.cli;

import dev.spectroscope.core.leveling.Ladder;
import dev.spectroscope.core.leveling.LevelingFold;
import dev.spectroscope.core.leveling.LevelingState;
import dev.spectroscope.core.leveling.LevelingStore;

import java.util.List;
import java.util.concurrent.Callable;

import picocli.CommandLine.Command;

/**
 * {@code spectro level} — the ladder in text, with ticks and receipts.
 *
 * <p>Reads the same {@code leveling/levels.json} the server and the web UI
 * read, and the same {@code ~/.spectro/leveling.json} the server writes. No
 * server needs to be running: this is a report, and reports do not need a
 * daemon.</p>
 *
 * <p>It reads and never writes. The state file has one writer by discipline,
 * and that writer is the server; a second one would make lost updates possible
 * for no gain.</p>
 *
 * <p>Names come from the level ids ({@code the-gate} reads as "the gate"), so
 * the terminal needs no copy table and cannot drift from the ladder file.</p>
 */
@Command(name = "level", description = "Show the leveling ladder and this home's progress.")
public final class LevelCommand implements Callable<Integer> {

    private final Ansi ansi = Ansi.detect();

    @Override
    public Integer call() {
        Ladder ladder = Ladder.bundled();
        LevelingState state = LevelingStore.userStore().read()
                .orElseGet(() -> LevelingState.fresh(LevelingState.Mode.CHECKLIST));
        System.out.println(ansi.coral("◆ ") + ansi.bold("spectroscope level"));
        System.out.println(render(ladder, state));
        return 0;
    }

    /**
     * The one-line summary the doctor prints.
     *
     * @param ladder the ladder in force
     * @param state this home's state
     * @return a single line, without a trailing newline
     */
    public static String doctorLine(Ladder ladder, LevelingState state) {
        if (state.mode() == LevelingState.Mode.OFF) {
            return "leveling: off";
        }
        int level = state.level(ladder);
        StringBuilder line = new StringBuilder("leveling: ")
                .append(state.mode().wire())
                .append(" · level ").append(level)
                .append(" (").append(display(ladder.levels().get(level).id())).append(")");
        if (level < ladder.levels().size() - 1) {
            List<String> advance = ladder.levels().get(level).advanceWhen();
            int met = advance.size() - LevelingFold.remaining(ladder, state).size();
            line.append(" · ").append(met).append('/').append(advance.size())
                    .append(" toward ").append(display(ladder.levels().get(level + 1).id()));
        }
        return line.toString();
    }

    /**
     * The full panel: every rung, every criterion, every receipt.
     *
     * @param ladder the ladder in force
     * @param state this home's state
     * @return a multi-line block, without a trailing newline
     */
    public static String render(Ladder ladder, LevelingState state) {
        int level = state.level(ladder);
        StringBuilder out = new StringBuilder(doctorLine(ladder, state));
        for (Ladder.Level rung : ladder.levels()) {
            out.append("\n\n  ").append(rung.index() == level ? "▸ " : "  ")
                    .append(display(rung.id()));
            if (rung.index() < level) {
                out.append("  (reached)");
            }
            List<Ladder.Criterion> gating = ladder.criteria().stream()
                    .filter(c -> c.level() == rung.index() && !c.mastery()).toList();
            List<Ladder.Criterion> mastery = ladder.criteria().stream()
                    .filter(c -> c.level() == rung.index() && c.mastery()).toList();
            for (Ladder.Criterion criterion : gating) {
                out.append('\n').append(row(criterion, state));
            }
            if (!mastery.isEmpty()) {
                out.append("\n      mastery (gates nothing)");
                for (Ladder.Criterion criterion : mastery) {
                    out.append('\n').append(row(criterion, state));
                }
            }
        }
        return out.toString();
    }

    private static String row(Ladder.Criterion criterion, LevelingState state) {
        LevelingState.Mark mark = state.marks().get(criterion.id());
        StringBuilder row = new StringBuilder("      ")
                .append(mark == null ? "·" : "✓").append(' ').append(criterion.id());
        if (mark != null) {
            row.append("  ");
            if (mark.origin() == LevelingState.Origin.MANUAL) {
                row.append("marked by hand");
            } else if (mark.sessionId() != null) {
                row.append(mark.sessionId());
                if (mark.eventIndex() != null) {
                    row.append('@').append(mark.eventIndex());
                }
            } else {
                row.append("observed");
            }
        }
        return row.toString();
    }

    /** {@code the-gate} reads as "the gate": the ids were written to be read. */
    private static String display(String levelId) {
        return levelId.replace('-', ' ');
    }
}
