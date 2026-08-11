package dev.spectroscope.core.graph;

/**
 * An update the merge must refuse: a node produced something other than a map
 * of channel updates, or two siblings wrote one non-folding channel in the same
 * superstep.
 *
 * <p>Carries the name and the base of LangGraph's own error for the same two
 * mistakes ({@code InvalidUpdateError} covers both there as well), so an
 * application that already catches one keeps working. The shape mistake is only
 * reachable through {@link StateUpdate#from(Object)} — the typed node interfaces
 * make it unrepresentable everywhere else; the collision is raised by the
 * runtime after the superstep's nodes returned and before any update lands.</p>
 */
public class InvalidUpdateException extends IllegalArgumentException {

    private static final long serialVersionUID = 1L;

    /**
     * @param message names the type that arrived and repeats the value
     */
    public InvalidUpdateException(String message) {
        super(message);
    }
}
