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

    /**
     * Card 312, round 3. {@code addressFieldFor} is a switch of three literal
     * cases and its javadoc said "the two local-model backends" while there
     * were three — the same class of defect as the CLI's first-run hint. The
     * switch stays a switch (it maps a name to a settings key), but the set it
     * has to cover is read off {@link SpectroConfig#keylessLocalServers()}, so
     * a fourth free local backend cannot arrive without a doctor line that can
     * name where it was dialled. Bitten by deleting the llamacpp case.
     */
    @Test
    void everyKeylessLocalServerHasAnAddressFieldTheDoctorCanName() {
        for (String provider : SpectroConfig.keylessLocalServers()) {
            String field = DoctorCommand.addressFieldFor(provider);
            assertNotNull(field,
                    "\"" + provider + "\" is dialled at an address of its own and the doctor"
                            + " knows no settings key for it, so its note cannot say where to"
                            + " change it — add a case to DoctorCommand.addressFieldFor");
            assertEquals(provider + "BaseUrl", field,
                    "the doctor names a settings key that is not this provider's own");
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
    void aGeneralAddressThatWouldNotHaveAppliedAnywayIsNotBlamedOnTheOverride() {
        // The one corner where the note's REASON was wrong while its claim was
        // right. effectiveOpenAiBaseUrl reads the literal http://localhost:11434
        // as "unset" for the openai-compat providers — a compatibility rule for
        // configs written before each backend had its own field — so an
        // lmstudio operator who typed exactly that value into the general field
        // is not losing it to lmstudioBaseUrl. He never had it. Clearing the
        // per-provider field to "get his general address back" lands him on LM
        // Studio's preset instead, which is what the old sentence promised him
        // out of.
        String note = DoctorCommand.perProviderAddressLines("lmstudio", "http://gpu-box:1234",
                "http://gpu-box:1234", "http://localhost:11434",
                new SpectroConfig.Origin("user", List.of()),
                new SpectroConfig.Origin("flags", List.of())).get(0).message();

        assertFalse(note.contains("a provider's own address wins"),
                "that is not why this general address does not apply — it would not have"
                        + " applied with the per-provider field empty either: " + note);
        assertTrue(note.contains("http://localhost:1234"),
                "so say where clearing the field WOULD land, which is the provider's own"
                        + " preset, not the typed address: " + note);
        assertTrue(note.contains("lmstudioBaseUrl") && note.contains("http://gpu-box:1234"),
                "the claim itself is unchanged — the per-provider address is what is"
                        + " dialled: " + note);
    }

    @Test
    void ollamaHasNoSuchCornerAndKeepsTheCausalSentence() {
        // effectiveOllamaBaseUrl carries no sentinel: any non-blank general
        // value is taken verbatim, the literal default included. So for ollama
        // the general address really would apply once ollamaBaseUrl is cleared,
        // and the note that says so is the true one.
        String note = DoctorCommand.perProviderAddressLines("ollama", "http://gpu-box:11434",
                "http://gpu-box:11434", "http://localhost:11434",
                new SpectroConfig.Origin("user", List.of()),
                new SpectroConfig.Origin("flags", List.of())).get(0).message();

        assertTrue(note.contains("a provider's own address wins"), note);
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

    @Test
    void theDoctorRunItselfCarriesTheShadowNoteForOllamaToo() throws IOException {
        // The twin of the test above, and it was missing: perProviderAddressOf
        // is a two-arm switch and only lmstudio's arm was held. Changing
        // ollama's arm to config.lmstudioBaseUrl() — the exact copy-paste slip
        // a two-arm switch invites — left the whole :spectro-cli:test module
        // green, while an ollama operator with both fields set silently lost
        // the note: perProviderAddressOf reads null, addressSet goes false.
        String out = doctorOutputForSettings("""
                { "provider": "ollama", "model": "qwen3",
                  "baseUrl": "http://127.0.0.1:5111",
                  "ollamaBaseUrl": "http://127.0.0.1:5222" }
                """);

        assertTrue(out.contains("ollamaBaseUrl"),
                "a doctor that probes 5222 while a baseUrl of 5111 sits in the same file"
                        + " must say which one it obeyed and why, got:\n" + out);
        assertTrue(out.contains("does NOT apply to ollama"),
                "and the note must be about ollama, not about whichever arm of the"
                        + " switch was read, got:\n" + out);
    }

    /**
     * The card 311 × 312 merge seam, held by the set instead of by a pair.
     *
     * <p>Card 311 built this note and pinned it with a literal twin per
     * backend — one test for lmstudio, one for ollama. Card 312 added a third
     * keyless local server on a branch that had never seen the note. The merge
     * was textually clean and every one of those twins stayed green, because a
     * pair of tests cannot notice a third member: {@code addressFieldFor} knew
     * llamacpp (card 312 added that arm), {@code perProviderAddressOf} did not,
     * so it read null, {@code addressSet} went false, and a llamacpp operator
     * with both fields set got exactly the silence card 311 exists to end.</p>
     *
     * <p>Derived, so a fourth backend cannot repeat it: the subjects are
     * {@link SpectroConfig#keylessLocalServers()}, and the whole doctor runs
     * rather than {@code perProviderAddressLines} being called by hand — the
     * defect lived between the two switches, not inside either.</p>
     *
     * @throws IOException when the settings document cannot be written
     */
    @Test
    void everyKeylessLocalServerGetsTheOverrideNoteFromAWholeDoctorRun() throws IOException {
        for (String provider : SpectroConfig.keylessLocalServers()) {
            String field = provider + "BaseUrl";
            String out = doctorOutputForSettings("{ \"provider\": \"" + provider + "\","
                    + " \"model\": \"some-model\","
                    + " \"baseUrl\": \"http://127.0.0.1:5111\","
                    + " \"" + field + "\": \"http://127.0.0.1:5222\" }");

            assertTrue(out.contains(field),
                    "a doctor that probes 5222 while a baseUrl of 5111 sits in the same file"
                            + " must name " + field + " and say why it won — \"" + provider
                            + "\" got no address line at all, so its own arm of"
                            + " DoctorCommand.perProviderAddressOf is missing, got:\n" + out);
            assertTrue(out.contains("does NOT apply to " + provider),
                    "and the note must be about \"" + provider + "\", not about whichever"
                            + " arm of the switch was read, got:\n" + out);
        }
    }

    /**
     * The other half of the same seam: the note's REASON, which card 311 split
     * in two because clearing the per-provider field does not always hand the
     * general address back.
     *
     * <p>{@code generalFallbackFor} answered {@code baseUrl} for anything its
     * switch did not name, and for llamacpp that is wrong: its rule skips the
     * legacy shared literal exactly as LM Studio's does, so an operator told
     * "clearing llamacppBaseUrl gives you this back" would have been sent after
     * a value he would never get. Measured against the config itself rather
     * than re-stated — the method's contract IS {@code endpointFor} with the
     * per-provider value unset, so the config resolves it and the doctor must
     * agree.</p>
     *
     * @throws IOException when the settings document cannot be written
     */
    @Test
    void theFallbackTheDoctorNamesIsTheOneAnEmptyFieldWouldResolve() throws IOException {
        // The legacy shared default first: it is the one value the openai-compat
        // rule reads as "unset", so it is where a missing arm changes the answer.
        for (String general : List.of("http://localhost:11434", "http://127.0.0.1:5111")) {
            for (String provider : SpectroConfig.keylessLocalServers()) {
                Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
                Files.writeString(SpectroConfig.USER_SETTINGS_PATH,
                        "{ \"provider\": \"" + provider + "\", \"baseUrl\": \"" + general + "\" }");
                SpectroConfig.Resolved resolved = SpectroConfig.loadResolved(
                        SpectroConfig.Overrides.none(), Path.of("."), null);

                // The premise: this run really does have the per-provider field
                // unset, so endpointFor below IS "the field cleared". An env var
                // on the machine would quietly measure something else.
                assertEquals("defaults", resolved.origins().get(provider + "BaseUrl").winner(),
                        provider + "BaseUrl came from the environment, so this run cannot"
                                + " say what an empty field would resolve to");
                assertEquals(resolved.config().endpointFor(provider),
                        DoctorCommand.generalFallbackFor(provider, general),
                        "with baseUrl=" + general + " the config would dial \""
                                + provider + "\" at one address and the doctor promises"
                                + " another — add its arm to DoctorCommand.generalFallbackFor");
            }
        }
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
