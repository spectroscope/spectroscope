package dev.spectroscope.server.spectrolyzr;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * Card 506, criterion 6: Spectrolyzr copies the two shipped fan-out
 * workflows into every generated playbook, for the archetypes service,
 * library and cli in every language, byte for byte as the pack ships them,
 * each with both why sentences.
 */
class SpectrolyzrWorkflowsTest {

    private static final List<String> WORKFLOWS = List.of("workflows/fanout-research.json",
            "workflows/fanout-review.json");

    @Test
    void everyGeneratedPlaybookCarriesBothWorkflowsByteForByte() throws IOException {
        ManifestReader.Read read = ManifestReader.read("spectrolyzr");
        assertEquals(List.of(), read.problems());
        Manifest manifest = read.manifest();
        int checked = 0;
        for (String archetype : List.of("service", "library", "cli")) {
            for (Manifest.Language language : manifest.languages()) {
                List<RenderedFile> files = Spectrolyzr.render(manifest,
                        new Choices(archetype, language.id(), List.of("spectro-playbook"), "ledger-api"));
                for (String path : WORKFLOWS) {
                    RenderedFile f = files.stream().filter(x -> x.root().equals("playbook") && x.path().equals(path))
                            .findFirst().orElseThrow(() -> new AssertionError(archetype + " " + language.id()
                                    + " has no " + path));
                    byte[] shipped = new ClassPathResource("bundled-playbooks/spectro/" + path).getContentAsByteArray();
                    assertArrayEquals(shipped, f.content().getBytes(StandardCharsets.UTF_8), archetype + " " + path);
                    assertFalse(f.why().en().isBlank(), path);
                    assertFalse(f.why().de().isBlank(), path);
                    checked++;
                }
            }
        }
        assertEquals(18, checked, "three archetypes, three languages, two files");
    }
}
