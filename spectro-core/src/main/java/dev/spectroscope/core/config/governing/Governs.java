package dev.spectroscope.core.config.governing;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * What one hardcoded number does to a run, and whether anybody outside this
 * file can change it.
 *
 * <p><b>Card 357.</b> A census of {@code spectro-core/src/main/java} on
 * 2026-09-01 found 121 numeric {@code static final}s, of which 76 had no
 * override path of any kind. (That census counted the four common primitives
 * only — it is a snapshot of a day, and the shape has been wider since a
 * reviewer found the {@code Duration} timeouts outside it. The live figures
 * are the registry's own length, which is why no total is written down
 * here.) The card was written believing they were
 * unexamined guesses; the measurement refuted that — 58 of the 76 carry a
 * written reason and 5 cite a measurement. <b>The gap was never thought, it
 * was reach:</b> the reasoning existed, carefully, inside a {@code .java} file
 * nobody but a maintainer ever opens, and not one of the 76 stated its value
 * anywhere in the 650 KB of published guide.</p>
 *
 * <p>This annotation is the reach. It carries only what cannot be read off the
 * source — the <b>kind</b> (can this be changed, and if not, why not), the
 * <b>unit</b>, and the settings key when there is one. <b>The explanation is
 * NOT repeated here</b>: {@code GoverningScan} lifts the javadoc that already
 * stands above the constant, so there is exactly one place where the reason
 * for a number lives, and it is the place a maintainer already writes it. An
 * annotation with its own {@code why = "..."} would have been a second
 * explanation written for the page — the very defect the card names.</p>
 *
 * <p><b>Every numeric {@code static final} in {@code spectro-core}'s main
 * sources must carry this annotation</b> — where "numeric" is the seven
 * primitives, an array of them, and {@link java.time.Duration}, which is the
 * list {@code GoverningScan.NUMERIC_TYPE} enforces and the only place it is
 * written. That includes the ones that govern nothing: {@link Kind#PLUMBING}
 * and {@link Kind#ALIAS} are how a constant says "not a governing number",
 * with the javadoc above it saying why. That is criterion 6 of the card — what
 * counts as governing has exactly one definition, declared at the constant
 * rather than inferred from its name by a list somebody has to remember to
 * update. {@code GoverningNumbersDriftTest} walks the source for the shape and
 * fails on the first unannotated one, so a further constant cannot ship
 * unclassified.</p>
 *
 * <p><b>The shape's reach is itself guarded</b>, because the first version of
 * it was not. It matched the four common primitives only, and 19 {@code
 * Duration} timeouts — the MCP transports, the headless browser, the four
 * search tiers — sat outside a registry whose javadoc said this sentence. A
 * reviewer proved it by adding a governing {@code Duration}, an {@code int[]}
 * and a {@code short} to the source and watching the drift test stay green.
 * The test {@code theShapeSeesEveryNumericConstantTheTreeDeclares} now derives
 * the EXCLUDED type names from the source, so the next family cannot be
 * invisible the way that one was.</p>
 *
 * @see GoverningNumbers
 */
@Documented
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.FIELD)
public @interface Governs {

    /**
     * Whether an operator can change this number, and if not, why not.
     *
     * @return the kind
     */
    Kind kind();

    /**
     * What the number counts. {@link Unit#NONE} only for plumbing.
     *
     * @return the unit
     */
    Unit unit();

    /**
     * The settings key, tool argument or hook field that overrides it — the
     * name an operator would search for. Empty for everything a person cannot
     * reach, which is most of them.
     *
     * @return the key, or the empty string
     */
    String key() default "";

    /**
     * Whether an operator can change a number, and if not, why not.
     *
     * <p>The kinds are DATA, not prose: the settings room groups by them and
     * translates their labels, so "fixed" and "fixed because a foreign server
     * says so" cannot blur into one sentence somebody rewrites later.</p>
     */
    enum Kind {

        /**
         * An operator can change it. A shipped call site actually passes
         * something else — a settings key, a CLI flag or a hook entry — and
         * {@link Governs#key()} names it.
         */
        SETTABLE,

        /**
         * The MODEL changes it, per call, and this is the default it gets
         * when it names none. An operator cannot reach it; the tool schema
         * can, which is a different promise and says so.
         */
        MODEL_CHOICE,

        /**
         * <b>It looks settable and is not.</b> A {@code DEFAULT_}-shaped name
         * over a parameterised overload that no shipped call site ever passes
         * anything but this default to. An audit that greps "is it
         * parameterised?" scores these as reachable; they are not, and this
         * kind exists so the page cannot repeat the mistake it was built to
         * expose (card 357 notes, card 364).
         */
        LOOKS_SETTABLE,

        /**
         * Fixed by something outside this codebase — a provider's wire limit,
         * a foreign library's own constant, a protocol maximum. Changing it
         * here would not change the thing that enforces it.
         */
        FOREIGN_CONTRACT,

        /**
         * Fixed here — no override path — and the javadoc above it is what the
         * code has to say about the value. The kind deliberately does NOT
         * claim the reasoning is good: the room prints the javadoc verbatim
         * and the reader judges it, which is the difference between reach and
         * a second explanation written for the page.
         */
        FIXED,

        /**
         * Fixed here, and the source records no argument for this particular
         * value — either it says so in its own words
         * ({@code MAX_PARALLEL_CHILDREN}: "nobody has measured whether the
         * house test backend serves four concurrent completions usefully") or
         * it says nothing about the value at all. The valuable kind: it is the
         * backlog, rendered.
         */
        UNEXAMINED,

        /**
         * Not an independent number — it restates another constant so a second
         * literal cannot drift from the first. The page lists it pointing at
         * its source rather than as a number of its own.
         */
        ALIAS,

        /**
         * Not a governing number at all: a unit conversion ({@code MIB}), a
         * sentinel that means "no value" ({@code NO_EXIT}), or a protocol
         * identifier whose value is arithmetic rather than choice
         * ({@code MAX_PORT}, {@code SCHEMA_VERSION}). Changing it does not
         * change what a run may do; it breaks the code.
         */
        PLUMBING;

        /**
         * Whether this kind governs a run — the one definition the registry,
         * the drift test and the settings room all read.
         *
         * @return false for {@link #ALIAS} and {@link #PLUMBING}, true otherwise
         */
        public boolean governs() {
            return this != ALIAS && this != PLUMBING;
        }
    }

    /** What a number counts. Small on purpose: a vocabulary the settings room
     *  can translate, not a free-text unit somebody spells two ways. */
    enum Unit {
        /** Turns of the agent loop. */
        TURNS,
        /** Completion tokens. */
        TOKENS,
        /** Characters of text. */
        CHARACTERS,
        /** Bytes. */
        BYTES,
        /** Milliseconds. */
        MILLISECONDS,
        /** Seconds. */
        SECONDS,
        /** A plain count of things. */
        COUNT,
        /** Per cent of something. */
        PERCENT,
        /** CSS pixels. */
        PIXELS,
        /** Lines of text. */
        LINES,
        /** A multiplier or a fraction. */
        RATIO,
        /** No unit — plumbing only. */
        NONE
    }
}
