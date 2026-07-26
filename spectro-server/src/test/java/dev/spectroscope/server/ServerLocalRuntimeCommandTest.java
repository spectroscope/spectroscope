package dev.spectroscope.server;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The catalogue made two things per-model that used to be constants: the
 * context window handed to llama-server, and the decision whether a live
 * runtime still matches what the operator selected. Both are pure, so both
 * are pinned here without spawning anything.
 */
class ServerLocalRuntimeCommandTest {

    @Test
    void theCommandCarriesTheModelsOwnContextWindow() {
        List<String> cmd = ServerLocalRuntime.buildCommand(
                "llama-server", Path.of("/tmp/m.gguf"), 8123, 8192);
        int c = cmd.indexOf("-c");
        assertTrue(c >= 0, "the context flag must be present");
        assertEquals("8192", cmd.get(c + 1),
                "the catalogue's contextTokens, not the old constant 4096");
        assertEquals("/tmp/m.gguf", cmd.get(cmd.indexOf("-m") + 1));
        assertEquals("127.0.0.1", cmd.get(cmd.indexOf("--host") + 1),
                "loopback binding is not negotiable");
    }

    @Test
    void aRunningRuntimeIsKeptOnlyForTheSameModel() {
        assertFalse(ServerLocalRuntime.needsRestart("qwen3-4b", "qwen3-4b"),
                "same model — keep the warm runtime and its loaded weights");
        assertTrue(ServerLocalRuntime.needsRestart("vibethinker-3b", "qwen3-4b"),
                "switched model — the old llama-server still serves the old weights");
        assertFalse(ServerLocalRuntime.needsRestart(null, "qwen3-4b"),
                "nothing running yet is not a restart, it is a start");
    }
}
