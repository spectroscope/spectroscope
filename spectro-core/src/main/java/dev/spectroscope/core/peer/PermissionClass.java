package dev.spectroscope.core.peer;

import java.util.Locale;
import java.util.Objects;

/**
 * The permission class of a mode, which is what travels with a peer message
 * as {@code from_mode} (card 502, concept decision 4).
 *
 * <p>The four modes fall into three classes: {@code ask} is {@code prompting},
 * {@code auto} and {@code extended} are {@code bypass}, {@code readonly} is
 * {@code readonly}. Two modes are the same class when their class names are
 * equal. An idle session starts a run on a message only from a sender of its
 * own class; any other class is held for the operator.</p>
 */
public final class PermissionClass {

    /** The class of {@code ask}. */
    public static final String PROMPTING = "prompting";
    /** The class of {@code auto} and {@code extended}. */
    public static final String BYPASS = "bypass";
    /** The class of {@code readonly}. */
    public static final String READONLY = "readonly";

    private PermissionClass() {
    }

    /**
     * The class of a mode, or of a class name read off the wire.
     *
     * @param mode a permission mode or a class name; null is the default mode {@code ask}
     * @return the class name, or null for a word that is neither
     */
    public static String of(String mode) {
        if (mode == null) {
            return PROMPTING;
        }
        return switch (mode.strip().toLowerCase(Locale.ROOT)) {
            case "ask", PROMPTING -> PROMPTING;
            case "auto", "extended", BYPASS -> BYPASS;
            case READONLY -> READONLY;
            default -> null;
        };
    }

    /**
     * Whether two modes are of the same class.
     *
     * @param a a mode or class name
     * @param b a mode or class name
     * @return true when both have a class and the class names are equal
     */
    public static boolean same(String a, String b) {
        return sameClass(of(a), of(b));
    }

    /**
     * Whether two class names are equal; an unknown class matches nothing.
     *
     * @param a a class name
     * @param b a class name
     * @return true when both are known and equal
     */
    public static boolean sameClass(String a, String b) {
        String left = of(a);
        return left != null && b != null && Objects.equals(left, of(b));
    }
}
