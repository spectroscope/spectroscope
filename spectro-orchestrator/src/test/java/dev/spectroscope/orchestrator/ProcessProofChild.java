package dev.spectroscope.orchestrator;

import dev.spectroscope.core.events.RunEvent;

/**
 * The child half of the process-boundary proof (card 22, bus-proof pattern):
 * a separate JVM that connects to the parent's hub, publishes its own PID and
 * exits. Its whole life is publish-then-close — which is exactly why
 * {@link ProcessBus#close()} must drain the outbox: without the drain, a
 * node's tail frames die with the process.
 */
final class ProcessProofChild {

    private ProcessProofChild() {
    }

    public static void main(String[] args) {
        int port = Integer.parseInt(args[0]);
        String contextId = args[1];
        try (ProcessBus bus = new ProcessBus("127.0.0.1", port, "child-proof")) {
            BusPublisher pen = new BusPublisher(bus, "node-child", contextId);
            pen.onEvent(new RunEvent.TextDelta("main",
                    "pid:" + ProcessHandle.current().pid(), System.currentTimeMillis()));
            pen.onEvent(new RunEvent.TextDelta("main", "done", System.currentTimeMillis()));
        }
    }
}
