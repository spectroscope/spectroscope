package dev.spectroscope.cli;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.local.LlamaServerBinary;
import dev.spectroscope.core.local.LocalCatalog;
import dev.spectroscope.core.local.ModelResolution;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 164: doctor's provider switch knew three of the seven providers and
 * called the other four "unknown provider", so the first command the docs
 * suggest ended red on a home configured for the built-in one. These pin both
 * halves of the fix — the built-in provider's own checks, and the drift guard
 * that fails the day an eighth provider joins {@code KNOWN_PROVIDERS} without
 * joining the switch.
 */
class DoctorProviderCheckTest {

    @AfterEach
    void cleanHome() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    // ── the drift guard ──────────────────────────────────────────────────────

    @Test
    void everyKnownProviderHasAReachabilityCheck() {
        for (String provider : SpectroConfig.knownProviders()) {
            assertNotNull(DoctorCommand.providerCheckFor(provider),
                    "doctor has no check for the known provider \"" + provider
                            + "\" — add a case to DoctorCommand.providerCheckFor, or the"
                            + " doctor will call it unknown and exit 1 (card 164)");
        }
    }

    @Test
    void aProviderNobodyKnowsStillFallsThrough() {
        assertNull(DoctorCommand.providerCheckFor("hal9000"),
                "the unknown branch must stay: a typo'd provider is still worth naming");
        assertFalse(SpectroConfig.isKnownProvider("hal9000"),
                "sanity: the fixture name really is not a provider");
    }

    // ── the built-in provider's own lines ────────────────────────────────────

    @Test
    void withoutALlamaServerTheBuiltInCheckFailsAndSaysHowToGetOne() {
        LocalCatalog.Model model = LocalCatalog.bundled().defaultModel();
        List<DoctorCommand.Line> lines = DoctorCommand.builtInProviderLines(
                Optional.empty(), model, downloaded(model));

        DoctorCommand.Line binary = lines.get(0);
        assertEquals(DoctorCommand.Kind.FAIL, binary.kind(),
                "no runtime binary means the built-in provider cannot answer at all");
        assertTrue(binary.message().contains("llama-server"), binary.message());
        assertTrue(binary.message().contains("llama.cpp"),
                "a red line without the remedy is half a diagnosis: " + binary.message());
    }

    @Test
    void aBundledBinaryPassesAndSaysItCameWithTheApp() {
        LocalCatalog.Model model = LocalCatalog.bundled().defaultModel();
        List<DoctorCommand.Line> lines = DoctorCommand.builtInProviderLines(
                Optional.of(new LlamaServerBinary.Found(
                        Path.of("/Applications/spectroscope.app/bin/llama-server"),
                        LlamaServerBinary.Source.BUNDLE)),
                model, downloaded(model));

        assertEquals(DoctorCommand.Kind.PASS, lines.get(0).kind());
        assertTrue(lines.get(0).message().contains("bundled"),
                "the desktop kit's promise is worth naming: " + lines.get(0).message());
    }

    @Test
    void aBinaryOnThePathPassesAndNamesWhereItIs() {
        LocalCatalog.Model model = LocalCatalog.bundled().defaultModel();
        List<DoctorCommand.Line> lines = DoctorCommand.builtInProviderLines(
                Optional.of(new LlamaServerBinary.Found(
                        Path.of("/opt/homebrew/bin/llama-server"), LlamaServerBinary.Source.PATH)),
                model, downloaded(model));

        assertEquals(DoctorCommand.Kind.PASS, lines.get(0).kind());
        assertTrue(lines.get(0).message().contains("/opt/homebrew/bin/llama-server"),
                lines.get(0).message());
    }

    @Test
    void anUndownloadedModelIsAnInfoLineAndNeverTurnsTheDoctorRed() {
        LocalCatalog.Model model = LocalCatalog.bundled().defaultModel();
        List<DoctorCommand.Line> lines = DoctorCommand.builtInProviderLines(
                Optional.of(new LlamaServerBinary.Found(
                        Path.of("/opt/homebrew/bin/llama-server"), LlamaServerBinary.Source.PATH)),
                model, absent(model));

        assertTrue(lines.stream().noneMatch(l -> l.kind() == DoctorCommand.Kind.FAIL),
                "a fresh install has not downloaded a model yet — that is the normal state,"
                        + " not a broken environment: " + lines);
        DoctorCommand.Line weights = lines.get(1);
        assertEquals(DoctorCommand.Kind.INFO, weights.kind());
        assertTrue(weights.message().contains(model.id()), weights.message());
        assertTrue(weights.message().contains("not downloaded"), weights.message());
    }

    @Test
    void aDownloadedModelPassesAndNamesTheFile() {
        LocalCatalog.Model model = LocalCatalog.bundled().defaultModel();
        List<DoctorCommand.Line> lines = DoctorCommand.builtInProviderLines(
                Optional.of(new LlamaServerBinary.Found(
                        Path.of("/opt/homebrew/bin/llama-server"), LlamaServerBinary.Source.PATH)),
                model, downloaded(model));

        assertEquals(DoctorCommand.Kind.PASS, lines.get(1).kind());
        assertTrue(lines.get(1).message().contains(model.file()), lines.get(1).message());
    }

    // ── the symptom the card was filed for ───────────────────────────────────

    @Test
    void aHomeConfiguredForTheBuiltInProviderIsNoLongerCalledUnknown() throws IOException {
        String out = doctorOutputFor("spectro-local");
        assertFalse(out.contains("unknown provider"),
                "the built-in provider that every fresh home offers was the one doctor"
                        + " refused to recognise, got:\n" + out);
        assertTrue(out.contains("built-in"), out);
    }

    @Test
    void theKeylessCloudProvidersAreCheckedByTheirOwnKeyVariable() throws IOException {
        for (String provider : List.of("openrouter", "gemini")) {
            String out = doctorOutputFor(provider);
            assertFalse(out.contains("unknown provider"),
                    provider + " has been a known provider since v0.2.0, got:\n" + out);
            assertTrue(out.contains(SpectroConfig.keyEnvFor(provider)),
                    "the line must name the variable that would fix it, got:\n" + out);
        }
    }

    // ── fixtures ─────────────────────────────────────────────────────────────

    private static ModelResolution.Resolved downloaded(LocalCatalog.Model model) {
        return new ModelResolution.Resolved(
                Path.of("/home/you/.spectro/models", model.file()), ModelResolution.Source.USER_DIR);
    }

    private static ModelResolution.Resolved absent(LocalCatalog.Model model) {
        return new ModelResolution.Resolved(
                Path.of("/home/you/.spectro/models", model.file()), ModelResolution.Source.ABSENT);
    }

    /** Runs the whole doctor against a user settings file naming {@code provider}. */
    private static String doctorOutputFor(String provider) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH,
                "{\"provider\": \"" + provider + "\"}");
        PrintStream original = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buffer, true, StandardCharsets.UTF_8));
        try {
            new DoctorCommand().call();
        } finally {
            System.setOut(original);
        }
        return buffer.toString(StandardCharsets.UTF_8);
    }
}
