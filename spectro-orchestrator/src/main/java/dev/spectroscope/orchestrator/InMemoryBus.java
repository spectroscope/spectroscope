package dev.spectroscope.orchestrator;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * The dev/test transport: synchronous fan-out to every subscriber of the
 * topic, on the publisher's thread (the CrewAI in-process pattern). A slow
 * consumer therefore backpressures its publisher — exactly the EventStream
 * discipline the core already lives by.
 */
public final class InMemoryBus implements BusTransport {

    private final Map<String, List<Consumer<BusEnvelope>>> topics = new ConcurrentHashMap<>();

    @Override
    public void publish(BusEnvelope frame) {
        for (Consumer<BusEnvelope> subscriber : topics.getOrDefault(frame.topic(), List.of())) {
            subscriber.accept(frame);
        }
    }

    @Override
    public AutoCloseable subscribe(String topic, Consumer<BusEnvelope> onFrame) {
        List<Consumer<BusEnvelope>> list =
                topics.computeIfAbsent(topic, t -> new CopyOnWriteArrayList<>());
        list.add(onFrame);
        return () -> list.remove(onFrame);
    }
}
