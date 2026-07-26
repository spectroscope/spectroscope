package dev.spectroscope.core.local;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What the default model has to be able to do. spectroscope's whole subject is
 * watching an agent work: the thinking channel and the tool calls ARE the
 * product. A default that cannot do both shows a newcomer half the app on their
 * first run, which is how Qwen2.5 Coder briefly held the slot — it is the
 * strongest tool caller here but has no think channel at all, and the empty
 * badge in the chooser is what gave it away.
 */
class LocalCatalogDefaultTest {

    @Test
    @DisplayName("the default model both thinks visibly and calls tools")
    void theDefaultShowsTheWholeProduct() {
        LocalCatalog.Model fallback = LocalCatalog.bundled().defaultModel();
        assertTrue(fallback.nativeTools(),
                fallback.id() + " is the default and must drive the agent's tools");
        assertTrue(fallback.reasoning(),
                fallback.id() + " is the default and must have a think channel to show");
    }

    @Test
    @DisplayName("the default is not the heaviest entry — a first run must be reachable")
    void theDefaultIsNotTheBiggestDownload() {
        LocalCatalog catalogue = LocalCatalog.bundled();
        long heaviest = catalogue.models().stream()
                .mapToLong(LocalCatalog.Model::sizeBytes).max().orElseThrow();
        assertTrue(catalogue.defaultModel().sizeBytes() < heaviest,
                "the default should not be the largest download in the catalogue");
    }
}
