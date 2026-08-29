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
                Optional.empty(), model.id(), model, downloaded(model));

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
                model.id(), model, downloaded(model));

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
                model.id(), model, downloaded(model));

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
                model.id(), model, absent(model));

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
                model.id(), model, downloaded(model));

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

    // ── the openai-compatible probe: reachable is not the same as usable ─────

    @Test
    void aKeylessCloudEndpointIsRedEvenThoughItAnswers() {
        List<DoctorCommand.Line> lines = DoctorCommand.openAiCompatLines(
                "openai", "https://api.openai.com", true, false);

        assertEquals(DoctorCommand.Kind.PASS, lines.get(0).kind(),
                "the endpoint really does answer — that half was never wrong");
        DoctorCommand.Line auth = lines.get(1);
        assertEquals(DoctorCommand.Kind.FAIL, auth.kind(),
                "an endpoint that refuses every call is not a healthy provider: " + lines);
        assertTrue(auth.message().contains("OPENAI_API_KEY"),
                "the line must name the variable that would fix it: " + auth.message());
    }

    @Test
    void aKeylessCloudEndpointThatIsAlsoUnreachableIsRedTwice() {
        // A gateway the operator pointed "openai" at, and that is down: both
        // questions have a bad answer and both are worth their own line.
        List<DoctorCommand.Line> lines = DoctorCommand.openAiCompatLines(
                "openai", "https://gateway.example.com", false, false);

        assertEquals(DoctorCommand.Kind.FAIL, lines.get(0).kind());
        assertTrue(lines.get(0).message().contains("unreachable"), lines.get(0).message());
        assertEquals(DoctorCommand.Kind.FAIL, lines.get(1).kind());
    }

    @Test
    void aCloudEndpointWithItsKeyIsGreen() {
        List<DoctorCommand.Line> lines = DoctorCommand.openAiCompatLines(
                "openai", "https://api.openai.com", true, true);

        assertTrue(lines.stream().noneMatch(l -> l.kind() == DoctorCommand.Kind.FAIL), lines.toString());
        assertTrue(lines.get(1).message().contains("OPENAI_API_KEY"), lines.get(1).message());
    }

    @Test
    void aLocalOpenAiCompatibleServerNeedsNoKey() {
        for (String endpoint : List.of("http://localhost:1234", "http://127.0.0.1:8000",
                "http://[::1]:1234")) {
            // lmstudio has no key variable at all, and "openai" is the generic
            // escape hatch routinely pointed at a keyless local server.
            for (String provider : List.of("lmstudio", "openai")) {
                List<DoctorCommand.Line> lines =
                        DoctorCommand.openAiCompatLines(provider, endpoint, true, false);
                assertTrue(lines.stream().noneMatch(l -> l.kind() == DoctorCommand.Kind.FAIL),
                        provider + " at " + endpoint + " is local and needs no key: " + lines);
                assertEquals(2, lines.size(),
                        "reachability and auth are two questions, always both answered: " + lines);
                assertTrue(lines.get(1).message().contains("no key"),
                        "say WHY this one is fine without a key: " + lines.get(1).message());
            }
        }
    }

    @Test
    void aKeylessProviderAtAPublicEndpointIsNotToldItIsOnItsOwnMachine() {
        // "local" is reached by two roads: the endpoint IS local, or the provider
        // has no key variable to send anywhere. Printing the first road's sentence
        // for both made doctor state, as a fact, that api.openai.com sits on the
        // operator's own machine — measured live, one env var away
        // (SPECTRO_PROVIDER=lmstudio SPECTRO_BASE_URL=https://api.openai.com).
        for (String endpoint : List.of("https://api.openai.com", "https://openrouter.ai/api")) {
            List<DoctorCommand.Line> lines =
                    DoctorCommand.openAiCompatLines("lmstudio", endpoint, true, false);
            String auth = lines.get(1).message();

            assertFalse(auth.contains("your own machine"),
                    "a public endpoint is not on this machine, whatever the verdict is: " + auth);
            assertTrue(auth.contains("no key"),
                    "the verdict itself is still right — lmstudio has no key to send: " + auth);
            assertTrue(auth.contains("lmstudio"),
                    "so the line must say WHY, and the why is the provider: " + auth);
        }
    }

    @Test
    void theAuthLineSpeaksTheProviderStatusVocabulary() {
        // ready | needs-key | local — the same three words /api/config and the
        // first-run dialog use, so doctor is not a fourth opinion.
        assertEquals("needs-key", SpectroConfig.onboardingStatusAt(
                "openai", "https://api.openai.com", false));
        assertEquals("ready", SpectroConfig.onboardingStatusAt(
                "openai", "https://api.openai.com", true));
        assertEquals("local", SpectroConfig.onboardingStatusAt(
                "openai", "http://localhost:1234", false));
        assertEquals("local", SpectroConfig.onboardingStatusAt(
                "lmstudio", "http://localhost:1234", false));
    }

    // ── card 193: the two doctor lines that print an address ─────────────────
    // Both were moved onto endpointFor by the card and neither was pinned:
    // reverting line 203 to config.baseUrl() and line 216 to
    // effectiveOpenAiBaseUrl(provider, config.baseUrl()) left the whole
    // :spectro-cli:test module green. Two of the card's five surfaces had no
    // guard at all, which is the same as not having been changed.

    @Test
    void theOllamaDoctorLineProbesAndNamesThePerProviderAddress() throws IOException {
        // Two closed ports: only WHICH one the line names is under test.
        String out = doctorOutputForSettings("""
                { "provider": "ollama", "model": "qwen3",
                  "baseUrl": "http://127.0.0.1:5111",
                  "ollamaBaseUrl": "http://127.0.0.1:5222" }
                """);

        assertTrue(out.contains("ollama at http://127.0.0.1:5222"),
                "doctor must probe and name ollama's OWN address, got:\n" + out);
        assertFalse(out.contains("5111"),
                "the legacy shared baseUrl is not what an ollama run dials, got:\n" + out);
    }

    @Test
    void theOpenAiCompatDoctorLineProbesAndNamesLmStudiosOwnAddress() throws IOException {
        String out = doctorOutputForSettings("""
                { "provider": "lmstudio", "model": "local-model",
                  "baseUrl": "http://127.0.0.1:5111",
                  "lmstudioBaseUrl": "http://127.0.0.1:5222" }
                """);

        assertTrue(out.contains("openai-compatible server at http://127.0.0.1:5222"),
                "doctor must probe and name LM Studio's OWN address, got:\n" + out);
        assertFalse(out.contains("5111"),
                "the legacy shared baseUrl is not what an lmstudio run dials, got:\n" + out);
    }

    // ── card 193, finding 5: the fixed priority, made visible ────────────────

    @Test
    void aPerProviderAddressOutrankingAHigherLayerBaseUrlIsSaidOutLoud() {
        // The measured case: --base-url on the command line, the per-provider
        // address in the environment. endpointFor applies a FIXED field
        // priority on top of the folded layers, so the flag loses — and the
        // env shadow report says nothing, because it keys per field and both
        // fields won their own.
        List<DoctorCommand.Line> lines = DoctorCommand.perProviderAddressLines(
                "ollama", "http://env-box:11434",
                "http://env-box:11434", "http://flag-box:11434",
                new SpectroConfig.Origin("env", List.of()),
                new SpectroConfig.Origin("flags", List.of()));

        assertEquals(1, lines.size(), "exactly one line, and it is a note: " + lines);
        String note = lines.get(0).message();
        assertEquals(DoctorCommand.Kind.INFO, lines.get(0).kind(),
                "a per-provider address is a legitimate configuration, not a fault");
        assertTrue(note.contains("ollamaBaseUrl"), note);
        assertTrue(note.contains("http://env-box:11434"),
                "name the address that actually wins: " + note);
        assertTrue(note.contains("from env"), "name the layer the winner came from: " + note);
        assertTrue(note.contains("from flags"),
                "and the layer of the value that is being ignored — that is the whole"
                        + " point of the line: " + note);
    }

    @Test
    void nothingIsSaidWhenThereIsNoShadowingToReport() {
        // No per-provider address: the legacy chain decides, nothing is hidden.
        assertTrue(DoctorCommand.perProviderAddressLines("ollama", "http://localhost:11434",
                null, "http://localhost:11434",
                new SpectroConfig.Origin("defaults", List.of()),
                new SpectroConfig.Origin("user", List.of())).isEmpty());
        // A per-provider address and NO baseUrl anywhere: nothing is being
        // overridden, so a line would be noise.
        assertTrue(DoctorCommand.perProviderAddressLines("lmstudio", "http://gpu-box:1234",
                "http://gpu-box:1234", "http://localhost:11434",
                new SpectroConfig.Origin("user", List.of()),
                new SpectroConfig.Origin("defaults", List.of())).isEmpty());
        // A provider with no per-provider address field at all.
        assertTrue(DoctorCommand.perProviderAddressLines("openai", "https://api.openai.com",
                null, "https://api.openai.com",
                new SpectroConfig.Origin("defaults", List.of()),
                new SpectroConfig.Origin("user", List.of())).isEmpty());
    }

    // ── card 311: a present key is not a value that wins ────────────────────

    @Test
    void aBlankPerProviderAddressIsNotAnOverrideAndIsNotReportedAsOne() throws IOException {
        // A hand-edited settings.json with the key present but empty. The fold
        // hands it a layer (Optional.ofNullable takes "" as a value), so the
        // Origin says "user" — while effectiveLmstudioBaseUrl reads a blank as
        // unset and dials baseUrl after all. A note here would name the wrong
        // winner and tell the operator their general address does not apply,
        // one line under a probe that just used it.
        String out = doctorOutputForSettings("""
                { "provider": "lmstudio", "model": "local-model",
                  "baseUrl": "http://127.0.0.1:5111",
                  "lmstudioBaseUrl": "" }
                """);

        assertTrue(out.contains("openai-compatible server at http://127.0.0.1:5111"),
                "a blank per-provider address falls through to baseUrl, got:\n" + out);
        assertFalse(out.contains("lmstudioBaseUrl"),
                "nothing is being overridden, so nothing may be claimed, got:\n" + out);
    }

    @Test
    void aBlankBaseUrlLeavesNoLoserToName() {
        // The mirror case: the per-provider address wins, but the value it
        // beats is empty — there is no address that "does not apply", and a
        // line about one would be noise.
        assertTrue(DoctorCommand.perProviderAddressLines("ollama", "http://gpu-box:11434",
                "http://gpu-box:11434", "  ",
                new SpectroConfig.Origin("user", List.of()),
                new SpectroConfig.Origin("user", List.of())).isEmpty());
    }

    @Test
    void theDoctorRunItselfCarriesTheShadowNote() throws IOException {
        String out = doctorOutputForSettings("""
                { "provider": "lmstudio", "model": "local-model",
                  "baseUrl": "http://127.0.0.1:5111",
                  "lmstudioBaseUrl": "http://127.0.0.1:5222" }
                """);

        assertTrue(out.contains("lmstudioBaseUrl"),
                "a doctor that probes 5222 while a baseUrl of 5111 sits in the same file"
                        + " must say which one it obeyed and why, got:\n" + out);
    }

    // ── the built-in provider's model swap ───────────────────────────────────

    @Test
    void aConfiguredModelOutsideTheCatalogueIsNamedTogetherWithTheOneThatRuns() {
        LocalCatalog.Model runs = LocalCatalog.bundled().defaultModel();
        List<DoctorCommand.Line> lines = DoctorCommand.builtInProviderLines(
                found(), "claude-opus-4-8", runs, absent(runs));

        String all = lines.toString();
        assertTrue(all.contains("claude-opus-4-8"),
                "doctor printed the configured model on the config line and then a"
                        + " different one here, with no word about the swap: " + all);
        assertTrue(lines.stream().anyMatch(l -> l.message().contains("claude-opus-4-8")
                        && l.message().contains(runs.id())),
                "one line must carry BOTH names, or the reader has to guess: " + all);
    }

    @Test
    void aConfiguredModelInTheCatalogueSaysNothingAboutSwapping() {
        LocalCatalog.Model runs = LocalCatalog.bundled().defaultModel();
        for (String configured : new String[] {runs.id(), null, ""}) {
            List<DoctorCommand.Line> lines =
                    DoctorCommand.builtInProviderLines(found(), configured, runs, absent(runs));
            assertTrue(lines.stream().noneMatch(l -> l.message().contains("instead")),
                    "nothing was swapped for \"" + configured + "\": " + lines);
        }
    }

    @Test
    void theModelSwapIsANoteAndNeverTurnsTheDoctorRed() {
        LocalCatalog.Model runs = LocalCatalog.bundled().defaultModel();
        List<DoctorCommand.Line> lines = DoctorCommand.builtInProviderLines(
                found(), "claude-opus-4-8", runs, downloaded(runs));

        assertTrue(lines.stream().noneMatch(l -> l.kind() == DoctorCommand.Kind.FAIL),
                "the runtime still answers — a stale id is a note, not a broken machine: " + lines);
    }

    // ── the vision line ──────────────────────────────────────────────────────

    @Test
    void theBuiltInProviderDoesNotClaimToSeeImages() {
        String line = DoctorCommand.visionLine("spectro-local", "qwen3-4b");
        assertFalse(line.contains("natively"),
                "the built-in runtime starts llama-server with the GGUF alone: " + line);
        assertTrue(line.contains("mmproj"),
                "name the reason, not just the verdict: " + line);
    }

    @Test
    void theProvidersWithNoVisionFactSayThatInsteadOfGuessing() {
        for (String provider : List.of("openai", "lmstudio", "openrouter", "gemini")) {
            String line = DoctorCommand.visionLine(provider, "some-model");
            assertFalse(line.contains("handles images natively"),
                    provider + " got the cloud claim by falling through an ollama-only"
                            + " branch, and nobody measured it: " + line);
            assertTrue(line.contains("unknown") || line.contains("vision-capable"),
                    "an unmeasured claim is worse than an admitted gap: " + line);
        }
    }

    @Test
    void ollamaKeepsTheHintItAlwaysHad() {
        String line = DoctorCommand.visionLine("ollama", "qwen3");
        assertTrue(line.contains("vision model"), line);
    }

    // ── fixtures ─────────────────────────────────────────────────────────────

    private static Optional<LlamaServerBinary.Found> found() {
        return Optional.of(new LlamaServerBinary.Found(
                Path.of("/opt/homebrew/bin/llama-server"), LlamaServerBinary.Source.PATH));
    }


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
        return doctorOutputForSettings("{\"provider\": \"" + provider + "\"}");
    }

    /** Runs the whole doctor against a complete user settings document. */
    private static String doctorOutputForSettings(String json) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, json);
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
