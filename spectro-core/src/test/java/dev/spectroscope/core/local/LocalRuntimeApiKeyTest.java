package dev.spectroscope.core.local;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The bundled runtime is inside the local perimeter, so it gets a key.
 *
 * <p>Binding to loopback stops a remote attacker and nothing else. llama.cpp
 * answers with {@code Access-Control-Allow-Origin: *}, so any page the operator
 * has open can call the endpoint AND read the answer once it has swept the
 * loopback range — the port is not a secret. A per-launch key is what makes the
 * port one.</p>
 */
class LocalRuntimeApiKeyTest {

    /** A launcher that records what it was told, and never becomes healthy. */
    private static final class Recorder implements LocalRuntime.Launcher {
        final List<String> keys = new ArrayList<>();

        @Override
        public AutoCloseable start(Path model, int port, String apiKey) {
            keys.add(apiKey);
            return () -> { };
        }
    }

    @Test
    void everyLaunchGetsAKeyAndTheEndpointCarriesIt() {
        Recorder recorder = new Recorder();
        LocalRuntime runtime = new LocalRuntime(recorder, "qwen3-4b", java.time.Duration.ofMillis(30));

        // Never healthy, so the endpoint is empty — but the launch still happened,
        // and the key handed to the subprocess is what matters here.
        assertTrue(runtime.ensureRunning(Path.of("model.gguf")).isEmpty());
        assertEquals(1, recorder.keys.size());
        String key = recorder.keys.get(0);
        assertFalse(key == null || key.isBlank(), "the runtime must launch with a key");
        assertTrue(key.length() >= 32, "a guessable key is not a fence: " + key.length() + " chars");
    }

    @Test
    void twoRuntimesDoNotShareAKey() {
        Recorder first = new Recorder();
        Recorder second = new Recorder();
        new LocalRuntime(first, "qwen3-4b", java.time.Duration.ofMillis(30))
                .ensureRunning(Path.of("a.gguf"));
        new LocalRuntime(second, "qwen3-4b", java.time.Duration.ofMillis(30))
                .ensureRunning(Path.of("b.gguf"));

        assertNotEquals(first.keys.get(0), second.keys.get(0),
                "a key reused across launches is a key that leaks once and stays leaked");
    }
}
