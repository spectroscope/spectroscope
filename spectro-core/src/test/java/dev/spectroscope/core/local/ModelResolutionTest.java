package dev.spectroscope.core.local;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** Locating the bundled GGUF across the two DMG shapes: baked into the app
 *  bundle (with-model DMG) vs. downloaded into the user models dir (lean DMG)
 *  vs. not there yet (the download target). */
class ModelResolutionTest {

    private static final String F = "vibethinker-3b-Q4_K_M.gguf";

    @Test
    void bundleWinsWhenPresent(@TempDir Path bundle, @TempDir Path userDir) throws Exception {
        Files.writeString(bundle.resolve(F), "gguf");
        var r = ModelResolution.locate(bundle, userDir, F);
        assertEquals(ModelResolution.Source.BUNDLE, r.source());
        assertEquals(bundle.resolve(F), r.path());
    }

    @Test
    void userDirWhenNoBundle(@TempDir Path userDir) throws Exception {
        Files.createDirectories(userDir);
        Files.writeString(userDir.resolve(F), "gguf");
        var r = ModelResolution.locate(null, userDir, F);   // lean build: no bundle dir
        assertEquals(ModelResolution.Source.USER_DIR, r.source());
        assertEquals(userDir.resolve(F), r.path());
    }

    @Test
    void absentPointsAtTheDownloadTarget(@TempDir Path userDir) {
        var r = ModelResolution.locate(null, userDir, F);
        assertEquals(ModelResolution.Source.ABSENT, r.source());
        assertEquals(userDir.resolve(F), r.path(), "the ABSENT path is where a download should land");
    }
}
