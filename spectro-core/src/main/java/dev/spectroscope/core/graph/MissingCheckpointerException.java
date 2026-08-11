package dev.spectroscope.core.graph;

/**
 * Raised when a thread question reaches a graph compiled without memory.
 *
 * <p>An unknown thread is not an error — {@link CheckpointSaver#get} answers it
 * with an empty snapshot, because "no history" is the normal state of a first
 * message. A missing checkpointer is the opposite: the graph was compiled
 * without memory, every thread question is meaningless, and answering with an
 * empty snapshot would dress a configuration bug as an empty conversation.</p>
 *
 * <p>An {@link IllegalStateException} rather than an argument problem: the
 * config may be perfectly well-formed — it is the GRAPH that is in the wrong
 * state to answer. (The python edition subclasses {@code ValueError} instead,
 * because its measured callers guard these calls with {@code except ValueError};
 * no such contract binds the Java surface.)</p>
 */
public class MissingCheckpointerException extends IllegalStateException {

    public MissingCheckpointerException() {
        super("No checkpointer set. Compile the graph with "
                + "compile(new InMemorySaver()) before asking a thread for its state "
                + "or its history.");
    }
}
