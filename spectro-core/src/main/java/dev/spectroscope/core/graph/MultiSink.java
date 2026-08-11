package dev.spectroscope.core.graph;

import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * One sink made of several: every record visits each sink, in declaration
 * order. Ported from the python edition's {@code MultiSink}, bare loop
 * included.
 *
 * <p>Deliberately NO per-sink isolation: a sink that throws starves the sinks
 * after it of that record, and the whole fan-out counts as one failure in the
 * runtime's absorbing emit. That is python parity, not an oversight — the
 * fail-safety seam lives in the runtime, where the loss is counted and warned
 * about once; a catch here would count nothing anywhere. A sink that wants to
 * survive its neighbours wraps itself.</p>
 *
 * <p>The canonical use is wiring both artifact files, where each file refuses
 * the other's vocabulary and the refusal is the routing:
 * {@code compile(new MultiSink(lifecycle, values), policy)}.</p>
 */
public final class MultiSink implements Consumer<Map<String, Object>> {

    private final List<Consumer<Map<String, Object>>> sinks;

    @SafeVarargs
    public MultiSink(Consumer<Map<String, Object>>... sinks) {
        this.sinks = List.of(sinks);
    }

    @Override
    public void accept(Map<String, Object> record) {
        for (Consumer<Map<String, Object>> sink : sinks) {
            sink.accept(record);
        }
    }
}
