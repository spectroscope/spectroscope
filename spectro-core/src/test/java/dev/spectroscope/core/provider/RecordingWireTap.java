package dev.spectroscope.core.provider;

import dev.spectroscope.core.wire.LlmWireTap;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * In-memory {@link LlmWireTap} for the loopback wire tests: keeps every
 * announced request, every teed line and every outcome, so a test can compare
 * the record against what the scripted server actually received and sent.
 * Lists are synchronized because the abort tests close exchanges from reader threads.
 */
final class RecordingWireTap implements LlmWireTap {

    final List<WireRequest> requests = Collections.synchronizedList(new ArrayList<>());
    final List<String> lines = Collections.synchronizedList(new ArrayList<>());
    final List<WireOutcome> outcomes = Collections.synchronizedList(new ArrayList<>());

    @Override
    public Exchange begin(WireRequest request) {
        requests.add(request);
        return new Exchange() {
            @Override
            public void line(String rawLine) {
                lines.add(rawLine);
            }

            @Override
            public void end(WireOutcome outcome) {
                outcomes.add(outcome);
            }
        };
    }
}
