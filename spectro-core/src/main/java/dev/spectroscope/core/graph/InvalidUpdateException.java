package dev.spectroscope.core.graph;

/**
 * A node produced something other than a map of channel updates.
 *
 * <p>Carries the name and the base of LangGraph's own error for the same
 * mistake, so an application that already catches one keeps working. Only
 * reachable through {@link StateUpdate#from(Object)} — the typed node interfaces
 * make the mistake unrepresentable everywhere else, which is the whole reason
 * the port is typed.</p>
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
