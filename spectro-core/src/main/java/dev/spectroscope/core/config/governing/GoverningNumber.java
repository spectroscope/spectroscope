package dev.spectroscope.core.config.governing;

/**
 * One hardcoded number that governs a run, as the settings room reads it.
 *
 * <p>Every field here is DERIVED. {@code GoverningScan} walks the source for
 * the shape, reads {@code kind}/{@code unit}/{@code key} off the
 * {@link Governs} annotation and the live value off the field itself, and
 * lifts {@code explanation} from the javadoc that already stands above the
 * constant. Nothing on this record was typed for the page, which is the whole
 * engineering content of card 357: a hand table of the constants would rot
 * before the next release, and this house has found that exact defect — a
 * hand-list guarded by a test that types the same hand-list — three times in
 * one card.</p>
 *
 * @param owner       the declaring class, fully qualified
 * @param field       the constant's name
 * @param value       its live value, rendered decimal — read off the field by
 *                    reflection, never re-typed from the source
 * @param expression  the initializer exactly as the source writes it, so
 *                    {@code 64L * 1024 * 1024} stays readable as arithmetic
 * @param kind        whether an operator can change it, and if not, why not
 * @param unit        what it counts
 * @param key         the settings key that overrides it, or the empty string
 * @param explanation the javadoc above the constant, tags flattened to text;
 *                    empty when the constant carries no javadoc at all
 */
public record GoverningNumber(String owner, String field, String value, String expression,
                              Governs.Kind kind, Governs.Unit unit, String key,
                              String explanation) {

    /**
     * The declaring class without its package — what the room shows as the
     * group heading, and short enough to read next to the constant's name.
     *
     * @return the simple class name
     */
    public String ownerSimpleName() {
        int dot = owner.lastIndexOf('.');
        return dot < 0 ? owner : owner.substring(dot + 1);
    }

    /**
     * Whether this number governs a run — {@link Governs.Kind#governs()},
     * asked of the entry rather than of the enum, so a caller never has to
     * know which kinds are the excluded ones.
     *
     * @return false for aliases and plumbing
     */
    public boolean governs() {
        return kind.governs();
    }
}
