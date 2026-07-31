package dev.spectroscope.core.local;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The catalogue is the single source for which models the built-in provider can
 * run: the picker, the download endpoint, the runtime and the docs all read it,
 * so a wrong entry here is a wrong entry everywhere. These pins are the reason
 * that is safe.
 */
class LocalCatalogTest {

    @Test
    @DisplayName("the bundled catalogue parses and offers more than one model")
    void bundledParses() {
        LocalCatalog catalogue = LocalCatalog.bundled();
        assertEquals(1, catalogue.schemaVersion());
        assertTrue(catalogue.models().size() >= 2,
                "a chooser with one entry is not a chooser");
    }

    @Test
    @DisplayName("every entry carries what a download and a run both need")
    void entriesAreComplete() {
        for (LocalCatalog.Model m : LocalCatalog.bundled().models()) {
            assertTrue(m.file().endsWith(".gguf"), m.id() + " must name a GGUF");
            assertTrue(m.url().startsWith("https://"), m.id() + " must be fetched over TLS");
            assertTrue(m.url().endsWith(".gguf"), m.id() + " must point straight at the weights");
            assertEquals(64, m.sha256().length(), m.id() + " needs a full sha256");
            assertTrue(m.sizeBytes() > 0, m.id() + " needs its real size for the progress bar");
            assertTrue(m.minRamBytes() >= m.sizeBytes(),
                    m.id() + " cannot need less memory than the weights it loads");
            assertTrue(m.contextTokens() > 0, m.id() + " needs a context budget");
            assertFalse(m.licence().isBlank(), m.id() + " must say what it is licensed under");
            assertTrue(m.sourceUrl().startsWith("https://"), m.id() + " must link its source");
            assertFalse(m.blurbKey().isBlank(), m.id() + " needs a blurb key");
            assertFalse(m.goodForKey().isBlank(), m.id() + " needs a good-for key");
        }
    }

    @Test
    @DisplayName("ids are unique and the default is one of them")
    void idsAreUniqueAndDefaultResolves() {
        LocalCatalog catalogue = LocalCatalog.bundled();
        Set<String> seen = new HashSet<>();
        for (LocalCatalog.Model m : catalogue.models()) {
            assertTrue(seen.add(m.id()), "duplicate model id " + m.id());
        }
        assertNotNull(catalogue.byId(catalogue.defaultId()),
                "the default id must name a model in the list");
    }

    @Test
    @DisplayName("file names are unique, or two models fight over one path on disk")
    void fileNamesAreUnique() {
        Set<String> seen = new HashSet<>();
        for (LocalCatalog.Model m : LocalCatalog.bundled().models()) {
            assertTrue(seen.add(m.file()), "two models share the file name " + m.file());
        }
    }

    @Test
    @DisplayName("at least one entry speaks native tool calls, and at least one does not")
    void theCatalogueSpansTheToolQuestion() {
        List<LocalCatalog.Model> models = LocalCatalog.bundled().models();
        assertTrue(models.stream().anyMatch(LocalCatalog.Model::nativeTools),
                "the point of the bigger models is that the agent loop can use tools");
        assertTrue(models.stream().anyMatch(m -> !m.nativeTools()),
                "the small reasoner is honest about not calling tools; keep that case covered");
    }

    @Test
    @DisplayName("VibeThinker keeps the on-disk name it shipped with")
    void theLegacyDownloadIsNotOrphaned() {
        LocalCatalog.Model vibe = LocalCatalog.bundled().byId("vibethinker-3b");
        assertNotNull(vibe, "the model 0.3.0 downloaded must stay in the catalogue");
        assertEquals("vibethinker-3b-Q4_K_M.gguf", vibe.file(),
                "renaming it would hide a 2 GB file an operator already has");
        assertFalse(vibe.url().endsWith(vibe.file()),
                "the upstream file is named differently, which is exactly why this pin exists");
    }

    @Test
    @DisplayName("a stale selection falls back to the default instead of failing")
    void staleSelectionFallsBack() {
        LocalCatalog catalogue = LocalCatalog.bundled();
        assertEquals(catalogue.defaultModel(), catalogue.resolve("retired-model"));
        assertEquals(catalogue.defaultModel(), catalogue.resolve(null));
        assertEquals(catalogue.byId("qwen3-8b"), catalogue.resolve("qwen3-8b"));
    }

    @Test
    @DisplayName("the profile the agent loop reads comes from the entry, not the provider name")
    void profileComesFromTheModel() {
        assertTrue(LocalCatalog.bundled().byId("qwen3-4b").profile().nativeTools());
        assertFalse(LocalCatalog.bundled().byId("vibethinker-3b").profile().nativeTools());
    }

    @Test
    @DisplayName("an unknown id resolves to null rather than a wrong model")
    void unknownIdIsNull() {
        assertEquals(null, LocalCatalog.bundled().byId("no-such-model"));
    }

    @Test
    @DisplayName("a blank id is a programming error, not a silent default")
    void blankIdThrows() {
        assertThrows(IllegalArgumentException.class, () -> LocalCatalog.bundled().byId(" "));
    }
}
