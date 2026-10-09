package dev.spectroscope.server.providers;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.local.LocalModel;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeFalse;

/** A provider's state is presence now plus the last check, never a guess. */
class ProviderRegistryTest {

    private final AtomicLong now = new AtomicLong(1_000_000L);

    @AfterEach
    void removeUserSettings() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    private static void writeUserSettings(String json) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, json);
    }

    private static SpectroConfig config() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }

    private static ProviderRow row(List<ProviderRow> rows, String id) {
        return rows.stream().filter(r -> r.id().equals(id)).findFirst().orElseThrow();
    }

    @Test
    void everyKnownProviderHasARowAndNoRowDialsAnything() {
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            throw new AssertionError("rows() must not dial " + p);
        }, now::get);
        List<ProviderRow> rows = registry.rows(config());
        assertEquals(SpectroConfig.knownProviders().stream().sorted().toList(),
                rows.stream().map(ProviderRow::id).toList());
    }

    @Test
    void aKeylessLocalServerStartsConfiguredAndBecomesReachableAfterACheck() throws IOException {
        writeUserSettings("{ \"ollamaBaseUrl\": \"http://127.0.0.1:11434\" }");
        ProviderRegistry registry = new ProviderRegistry(
                (p, c) -> ListResult.ok(List.of("qwen3:8b"), c.endpointFor(p)), now::get);
        assertEquals("configured", row(registry.rows(config()), "ollama").state());
        ProviderRow checked = registry.check("ollama", config());
        assertEquals("reachable", checked.state());
        assertEquals(List.of("qwen3:8b"), checked.models());
        assertTrue(checked.live());
        assertEquals(1_000_000L, checked.checkedAt());
        assertEquals("local", checked.kind());
    }

    @Test
    void aFailedCheckKeepsItsReasonAndAddress() throws IOException {
        writeUserSettings("{ \"lmstudioBaseUrl\": \"http://127.0.0.1:1\" }");
        ProviderRegistry registry = new ProviderRegistry(
                (p, c) -> ListResult.failed("refused", c.endpointFor(p)), now::get);
        ProviderRow checked = registry.check("lmstudio", config());
        assertEquals("failed", checked.state());
        assertEquals("refused", checked.reason());
        assertEquals("http://127.0.0.1:1", checked.endpoint());
    }

    @Test
    void aStoredResultIsForgottenWhenTheAddressChanges() throws IOException {
        writeUserSettings("{ \"ollamaBaseUrl\": \"http://127.0.0.1:11434\" }");
        ProviderRegistry registry = new ProviderRegistry(
                (p, c) -> ListResult.ok(List.of("a"), c.endpointFor(p)), now::get);
        registry.check("ollama", config());
        writeUserSettings("{ \"ollamaBaseUrl\": \"http://127.0.0.1:11435\" }");
        assertEquals("configured", row(registry.rows(config()), "ollama").state(),
                "a result for another address must not be shown for this one");
    }

    @Test
    void invalidateDropsTheStoredResult() throws IOException {
        writeUserSettings("{ \"ollamaBaseUrl\": \"http://127.0.0.1:11434\" }");
        ProviderRegistry registry = new ProviderRegistry(
                (p, c) -> ListResult.ok(List.of("a"), c.endpointFor(p)), now::get);
        registry.check("ollama", config());
        registry.invalidate("ollama");
        assertEquals("configured", row(registry.rows(config()), "ollama").state());
    }

    @Test
    void invalidatingOneProviderLeavesTheOthersStoredAnswerAlone() throws IOException {
        // The key save routes call invalidate for the provider whose key they wrote;
        // the positive half pins that the other providers keep what they measured.
        writeUserSettings("{ \"ollamaBaseUrl\": \"http://127.0.0.1:11434\","
                + " \"lmstudioBaseUrl\": \"http://127.0.0.1:1234\" }");
        ProviderRegistry registry = new ProviderRegistry(
                (p, c) -> ListResult.ok(List.of("m"), c.endpointFor(p)), now::get);
        registry.check("ollama", config());
        registry.check("lmstudio", config());
        registry.invalidate("ollama");
        assertEquals("configured", row(registry.rows(config()), "ollama").state());
        assertEquals("reachable", row(registry.rows(config()), "lmstudio").state());
    }

    @Test
    void aCloudProviderWithoutAKeyNeedsAKeyAndIsNeverChecked() {
        assumeFalse(SpectroConfig.hasApiKey("OPENROUTER_API_KEY"),
                "an OPENROUTER_API_KEY on this machine makes the provider keyed");
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            throw new AssertionError("a needs-key provider must not be dialled");
        }, now::get);
        ProviderRow checked = registry.check("openrouter", config());
        assertEquals("needs-key", checked.state());
        assertFalse(checked.keyPresent());
        assertEquals("cloud", checked.kind());
        assertNull(checked.credential(), "a keyed provider speaks through keyPresent only");
    }

    @Test
    void theSignInCredentialFormHasItsOwnWordsAndNoProviderUsesItYet() {
        for (String p : SpectroConfig.knownProviders()) {
            assertEquals(ProviderRegistry.CREDENTIAL_KEY, ProviderRegistry.credentialFormOf(p),
                    p + " is keyed until card 478 brings a sign-in provider");
        }
        assertEquals("key", ProviderRegistry.CREDENTIAL_KEY);
        assertEquals("signin", ProviderRegistry.CREDENTIAL_SIGNIN);
        assertEquals("needs-key", ProviderRegistry.missingCredentialState(ProviderRegistry.CREDENTIAL_KEY));
        assertEquals("needs-signin", ProviderRegistry.missingCredentialState(ProviderRegistry.CREDENTIAL_SIGNIN));
        assertEquals("signed-in", ProviderRegistry.credentialWord(ProviderRegistry.CREDENTIAL_SIGNIN, true));
        assertEquals("not-signed-in", ProviderRegistry.credentialWord(ProviderRegistry.CREDENTIAL_SIGNIN, false));
        assertNull(ProviderRegistry.credentialWord(ProviderRegistry.CREDENTIAL_KEY, true));
        assertNull(ProviderRegistry.credentialWord(ProviderRegistry.CREDENTIAL_KEY, false));
    }

    @Test
    void openaiAtAPrivateAddressWithoutAKeyIsLocal() throws IOException {
        assumeFalse(SpectroConfig.hasApiKey("OPENAI_API_KEY"),
                "an OPENAI_API_KEY on this machine changes the key half of the claim");
        // openai owns no address field of its own; it is dialled at the shared baseUrl.
        writeUserSettings("{ \"baseUrl\": \"http://192.168.1.20:8080\" }");
        ProviderRegistry registry = new ProviderRegistry(
                (p, c) -> ListResult.ok(List.of(), c.endpointFor(p)), now::get);
        ProviderRow r = row(registry.rows(config()), "openai");
        assertEquals("http://192.168.1.20:8080", r.endpoint());
        assertEquals("local", r.kind());
        assertEquals("configured", r.state(), "not needs-key: the address is on the operator's network");
    }

    @Test
    void theBuiltInProviderIsNeverChecked() {
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            throw new AssertionError("spectro-local must not be dialled");
        }, now::get);
        ProviderRow r = registry.check("spectro-local", config());
        assertEquals("builtin", r.kind());
        assertTrue("configured".equals(r.state()) || "needs-download".equals(r.state()));
        assertNull(r.reason());
    }

    @Test
    void theBuiltInProviderIsNeverCheckedEvenWithItsModelOnDisk(@TempDir Path bundle) throws IOException {
        Files.createFile(bundle.resolve(LocalModel.FILE));
        String before = System.getProperty("spectro.bundle.models");
        System.setProperty("spectro.bundle.models", bundle.toString());
        try {
            ProviderRegistry registry = new ProviderRegistry((p, c) -> {
                throw new AssertionError("spectro-local must not be dialled: a check would start llama-server");
            }, now::get);
            ProviderRow r = registry.check("spectro-local", config());
            assertEquals("builtin", r.kind());
            assertEquals("configured", r.state(), "the model file is on disk");
            assertEquals(0L, r.checkedAt());
        } finally {
            if (before == null) {
                System.clearProperty("spectro.bundle.models");
            } else {
                System.setProperty("spectro.bundle.models", before);
            }
        }
    }

    @Test
    void aResultOlderThanItsTimeToLiveReadsConfiguredAgain() throws IOException {
        writeUserSettings("{ \"ollamaBaseUrl\": \"http://127.0.0.1:11434\" }");
        ProviderRegistry registry = new ProviderRegistry(
                (p, c) -> ListResult.ok(List.of("a"), c.endpointFor(p)), now::get);
        registry.check("ollama", config());
        now.addAndGet(ProviderRegistry.LOCAL_TTL_MS + 1);
        ProviderRow r = row(registry.rows(config()), "ollama");
        assertEquals("configured", r.state());
        assertEquals(1_000_000L, r.checkedAt(), "the old time stays visible as the age");
    }
}
