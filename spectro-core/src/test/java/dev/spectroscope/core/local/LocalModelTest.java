package dev.spectroscope.core.local;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The bundled model's identity + a presence check both the server status and
 *  the download dialog read. */
class LocalModelTest {

    @Test
    void identityIsStable() {
        assertEquals("vibethinker-3b", LocalModel.MODEL_ID);
        assertTrue(LocalModel.FILE.endsWith(".gguf"));
    }

    @Test
    void absentThenPresentAcrossTheUserDir(@TempDir Path userDir) throws Exception {
        assertFalse(LocalModel.presentIn(null, userDir), "nothing bundled, nothing downloaded");
        Files.writeString(userDir.resolve(LocalModel.FILE), "gguf");
        assertTrue(LocalModel.presentIn(null, userDir), "the downloaded model is found");
    }

    @Test
    void aBundledModelCounts(@TempDir Path bundle, @TempDir Path userDir) throws Exception {
        Files.writeString(bundle.resolve(LocalModel.FILE), "gguf");
        assertTrue(LocalModel.presentIn(bundle, userDir), "the with-model DMG bundles it");
    }

    @Test
    void anyPresentSeesEveryCatalogueModel(@TempDir Path userDir) throws Exception {
        assertFalse(LocalModel.anyPresentIn(null, userDir), "an empty home has no model");
        // Not the legacy FILE — any catalogue entry counts, because the provider
        // is usable as soon as one model is on disk, whichever one that is.
        Files.writeString(userDir.resolve(
                LocalCatalog.bundled().defaultModel().file()), "gguf");
        assertTrue(LocalModel.anyPresentIn(null, userDir));
    }
}
