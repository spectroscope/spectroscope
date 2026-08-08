package dev.spectroscope.server.localmodel;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
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
                "llama-server", Path.of("/tmp/m.gguf"), 8123, 8192, "k");
        int c = cmd.indexOf("-c");
        assertTrue(c >= 0, "the context flag must be present");
        assertEquals("8192", cmd.get(c + 1),
                "the catalogue's contextTokens, not the old constant 4096");
        assertEquals("/tmp/m.gguf", cmd.get(cmd.indexOf("-m") + 1));
        assertEquals("127.0.0.1", cmd.get(cmd.indexOf("--host") + 1),
                "loopback binding is not negotiable");
    }

    @Test
    void aBundledBinaryCountsAsAvailableWithoutAnythingInstalled(@TempDir Path bundle)
            throws Exception {
        // The desktop kit's whole promise: nothing installed, still available.
        Path binary = Files.createFile(bundle.resolve("llama-server"));
        binary.toFile().setExecutable(true);
        String previous = System.getProperty("spectro.bundle.bin");
        try {
            System.setProperty("spectro.bundle.bin", bundle.toString());
            assertTrue(ServerLocalRuntime.binaryAvailable(),
                    "a bundled, executable llama-server is the whole point of card 100");
        } finally {
            if (previous == null) {
                System.clearProperty("spectro.bundle.bin");
            } else {
                System.setProperty("spectro.bundle.bin", previous);
            }
        }
    }

    @Test
    void aBundleWithoutTheBinaryDoesNotCount(@TempDir Path bundle) {
        String previous = System.getProperty("spectro.bundle.bin");
        try {
            System.setProperty("spectro.bundle.bin", bundle.toString());
            // Empty bundle: the answer must come from the PATH probe, never from
            // the mere presence of the property — that is what made the old
            // binary() fall through to a "llama-server" that may not exist.
            assertEquals(pathHasLlamaServer(), ServerLocalRuntime.binaryAvailable());
        } finally {
            if (previous == null) {
                System.clearProperty("spectro.bundle.bin");
            } else {
                System.setProperty("spectro.bundle.bin", previous);
            }
        }
    }

    private static boolean pathHasLlamaServer() {
        String path = System.getenv("PATH");
        if (path == null) {
            return false;
        }
        for (String entry : path.split(java.io.File.pathSeparator)) {
            if (!entry.isBlank() && Files.isExecutable(Path.of(entry, "llama-server"))) {
                return true;
            }
        }
        return false;
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

    @Test
    void theCommandCarriesAnApiKeySoTheEndpointIsNotOpenToTheMachine() {
        List<String> cmd = ServerLocalRuntime.buildCommand(
                "llama-server", Path.of("/m/qwen.gguf"), 8123, 8192, "s3cret-per-launch");

        int flag = cmd.indexOf("--api-key");
        assertTrue(flag >= 0, "llama-server must be started with a key: " + cmd);
        assertEquals("s3cret-per-launch", cmd.get(flag + 1));
    }
}
