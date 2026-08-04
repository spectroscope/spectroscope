package dev.spectroscope.core.local;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The llama-server lookup moved down into core so the CLI's doctor can ask the
 * same question the server already asked (card 164). These pin the rule itself
 * over injected roots — no system properties, no real PATH.
 */
class LlamaServerBinaryTest {

    @Test
    void anExecutableInTheBundleWinsAndNamesItselfAsBundled(@TempDir Path bundle) throws Exception {
        Path binary = Files.createFile(bundle.resolve("llama-server"));
        assertTrue(binary.toFile().setExecutable(true));

        Optional<LlamaServerBinary.Found> found = LlamaServerBinary.findIn(bundle.toString(), "");
        assertTrue(found.isPresent(), "the desktop kit bundles one — that is card 100's promise");
        assertEquals(LlamaServerBinary.Source.BUNDLE, found.get().source());
        assertEquals(binary, found.get().path());
    }

    @Test
    void aBundleDirWithoutTheBinaryFallsThroughToThePath(@TempDir Path bundle, @TempDir Path onPath)
            throws Exception {
        Path binary = Files.createFile(onPath.resolve("llama-server"));
        assertTrue(binary.toFile().setExecutable(true));

        Optional<LlamaServerBinary.Found> found =
                LlamaServerBinary.findIn(bundle.toString(), onPath.toString());
        assertTrue(found.isPresent(), "an empty bundle dir must not shadow a real PATH entry");
        assertEquals(LlamaServerBinary.Source.PATH, found.get().source());
        assertEquals(binary, found.get().path());
    }

    @Test
    void aNonExecutableFileIsNotABinary(@TempDir Path onPath) throws Exception {
        Path binary = Files.createFile(onPath.resolve("llama-server"));
        assertTrue(binary.toFile().setExecutable(false));

        assertTrue(LlamaServerBinary.findIn(null, onPath.toString()).isEmpty(),
                "a file nobody can exec cannot serve a model");
    }

    @Test
    void nothingAnywhereIsAnHonestEmpty(@TempDir Path empty) {
        assertTrue(LlamaServerBinary.findIn(null, empty.toString()).isEmpty());
        assertTrue(LlamaServerBinary.findIn("", "").isEmpty());
        assertTrue(LlamaServerBinary.findIn(null, null).isEmpty(),
                "a process without a PATH at all is not a crash, it is an absent binary");
    }

    @Test
    void blankAndJunkPathEntriesAreSkippedRatherThanFatal(@TempDir Path onPath) throws Exception {
        Path binary = Files.createFile(onPath.resolve("llama-server"));
        assertTrue(binary.toFile().setExecutable(true));
        String path = "" + File.pathSeparator + "  " + File.pathSeparator + onPath;

        assertTrue(LlamaServerBinary.findIn(null, path).isPresent(),
                "one junk entry must not end the search");
    }

    @Test
    void availableIsTheYesNoFormOfTheSameLookup(@TempDir Path bundle) throws Exception {
        assertFalse(LlamaServerBinary.availableIn(bundle.toString(), ""));
        Path binary = Files.createFile(bundle.resolve("llama-server"));
        assertTrue(binary.toFile().setExecutable(true));
        assertTrue(LlamaServerBinary.availableIn(bundle.toString(), ""));
    }
}
