package dev.spectroscope.core.graph;

/**
 * A graph that cannot be drawn, raised where the mistake was made.
 *
 * <p>Extends {@link IllegalArgumentException} because that is this codebase's
 * answer to python's {@code ValueError}, which is what both LangGraph and the
 * python edition raise for a duplicate node or a missing entry point. A caller
 * already guarding {@code compile()} does not have to learn a new type.</p>
 *
 * <p>Every message names the offender and, where the answer depends on it, the
 * declared nodes. An edge pointing at a node nobody declared, a graph with no
 * way in, a node no path can reach — each of those is a drawing with a hole in
 * it, and a message that only says "invalid graph" leaves the reader to find
 * which one.</p>
 */
public class GraphValidationException extends IllegalArgumentException {

    private static final long serialVersionUID = 1L;

    /**
     * @param message names the offending node, edge or branch
     */
    public GraphValidationException(String message) {
        super(message);
    }
}
