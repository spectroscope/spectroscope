package dev.spectroscope.core.graph;

/**
 * A run took its whole superstep budget without reaching END.
 *
 * <p>An unchecked exception rather than an {@link Error}: python's
 * {@code RecursionError} is a recoverable exception there, and a caller that
 * wants to answer "your graph is cycling" with an HTTP 500 has to be able to
 * catch it. Java's own {@link StackOverflowError} is the wrong analogue — no
 * stack is deep here, a loop simply has no exit.</p>
 *
 * <p>The message names the cycle and the knob that widens it. Whoever hits this
 * is looking at a hung request, and a number alone tells them nothing they can
 * act on.</p>
 */
public class GraphRecursionException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    /**
     * @param message the cycle, the ceiling, and how to raise it
     */
    public GraphRecursionException(String message) {
        super(message);
    }
}
