package dev.spectroscope.core.graph;

/**
 * What a node (or a routing decision) writes intermediate chunks through,
 * obtained via {@link CompiledGraph#streamWriter()} — the python edition's
 * {@code get_stream_writer()}, synchronously.
 *
 * <p>Inside a run the writer is always real and never {@code null}: a caller
 * branching on its presence takes its streaming path, and when nobody asked for
 * {@code CUSTOM} chunks the write simply costs nothing. Outside a run there is
 * no writer to have, and asking raises — callers use the raise as "this code is
 * not being streamed".</p>
 */
@FunctionalInterface
public interface StreamWriter {

    /**
     * @param chunk whatever the caller wants the stream consumer to see, delivered
     *              inline on the run's own thread, before the node's update lands
     */
    void write(Object chunk);
}
