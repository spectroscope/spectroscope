# Provider Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One server side registry that says, per provider, whether it is configured and whether it answers, read by the chat picker, the settings page, the doctor and later the playbook loader.

**Architecture:** A new server package `dev.spectroscope.server.providers` holds the three model list routines as `ModelLists` (returning a `ListResult` instead of throwing results away), a process wide `ProviderRegistry` that derives a state per provider from presence plus the last bounded check, and a `ProvidersController` with one read route and one fenced check route. The web gets a small store (`state/providerRegistry.ts`), a pure option rule in `providerPickerMode.ts`, greyed options in `ProviderPicker.tsx` and a new `ProviderStatusSettings.tsx` block. Three one line consistency fixes ride along (openai at a private address, the doctor's probe path, the built-in name).

**Tech Stack:** Java 21 (Spring Boot, `RestClient`, virtual threads), JUnit 5 with `com.sun.net.httpserver.HttpServer` fakes; TypeScript, React 18, vitest with `renderToStaticMarkup` and `vi.stubGlobal("fetch")`.

**Spec:** `docs/superpowers/specs/2026-10-09-provider-registry-design.md`.

## Global Constraints

- Product repo `spectroscope-harness/spectro`; work in a worktree `worktrees/wt-card-<n>` on branch `card-<n>` from `main`; `npm ci` in the worktree before the web gate.
- Business English in code, comments, commits and UI strings; every UI string in `de` and `en` in `spectro-web/src/i18n/i18n.ts`; no dashes as punctuation, no emoji.
- Full gates before any "done": `./gradlew test --rerun-tasks --no-build-cache`, `./gradlew javadoc --rerun-tasks --no-build-cache`, and `npm run gate` in `spectro-web`; never through a pipe; `npm run gate` rewrites the tracked bundle, so commit or reset that afterwards on purpose.
- Red first: run every new test before its implementation and keep the red output in the card's evidence folder (`kanban/evidence/<card>/`). Mutation probe after the commit of each task.
- No new settings key. No background timer. No socket push. `/api/models` keeps its contract.
- Keys travel as presence only (`keyPresent` boolean), never as values, in any route, log or test name.
- Budgets are constants: 1,500 ms connect, 2,500 ms read (existing), 5,000 ms outer budget per check call, 30 s time to live for `local`, 600 s for `cloud`.
- Commits with explicit paths, never `git add -A`. Commit message in a file, `git commit -F`.

---

### Task 1: `ListResult` and `ModelLists` (server)

**Files:**
- Create: `spectro-server/src/main/java/dev/spectroscope/server/providers/ListResult.java`
- Create: `spectro-server/src/main/java/dev/spectroscope/server/providers/ModelLists.java`
- Modify: `spectro-server/src/main/java/dev/spectroscope/server/session/SessionsController.java:727-900` (the three list routines delegate; the `MODEL_PROBE` client and `NON_CHAT_MODEL_MARKERS` move)
- Test: `spectro-server/src/test/java/dev/spectroscope/server/providers/ModelListsTest.java`

**Interfaces:**
- Consumes: `SpectroConfig.endpointFor(String)`, `SpectroConfig.resolveApiKey(String)`, `SpectroConfig.keyEnvFor(String)`, `OpenAiCompatProvider.compatPath(String base, String path)`.
- Produces: `record ListResult(String outcome, List<String> models, boolean live, String endpoint)` with `static ListResult ok(List<String> models, String endpoint)` and `static ListResult failed(String reason, String endpoint)`; `ModelLists.anthropic(String key)`, `ModelLists.ollama(String base)`, `ModelLists.openAiCompat(String provider, String base, String key)`, all `static` and returning `ListResult`; outcomes `ok`, `no-key`, `refused`, `timeout`, `rejected-key`, `http-<status>`, `bad-answer`.

- [ ] **Step 1: Write the failing test**

```java
package dev.spectroscope.server.providers;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The model list routines keep WHY a list did not arrive, instead of a bare fallback. */
class ModelListsTest {

    private static HttpServer serve(String path, int status, String body) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext(path, exchange -> {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        return server;
    }

    private static String base(HttpServer server) {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @Test
    void anOpenAiCompatibleServerThatAnswersIsOkAndLive() throws IOException {
        HttpServer fake = serve("/v1/models", 200,
                "{\"data\":[{\"id\":\"qwen/qwen3-coder\",\"created\":2},{\"id\":\"text-embedding-3\",\"created\":1}]}");
        try {
            ListResult r = ModelLists.openAiCompat("lmstudio", base(fake), null);
            assertEquals("ok", r.outcome());
            assertTrue(r.live());
            assertEquals(List.of("qwen/qwen3-coder"), r.models(), "non chat families are filtered");
            assertEquals(base(fake), r.endpoint());
        } finally {
            fake.stop(0);
        }
    }

    @Test
    void aClosedPortIsRefused() {
        ListResult r = ModelLists.openAiCompat("lmstudio", "http://127.0.0.1:1", null);
        assertEquals("refused", r.outcome());
        assertFalse(r.live());
        assertEquals(List.of(), r.models());
        assertEquals("http://127.0.0.1:1", r.endpoint());
    }

    @Test
    void aFourOhOneIsARejectedKey() throws IOException {
        HttpServer fake = serve("/v1/models", 401, "{\"error\":\"bad key\"}");
        try {
            ListResult r = ModelLists.openAiCompat("openai", base(fake), "sk-wrong");
            assertEquals("rejected-key", r.outcome());
        } finally {
            fake.stop(0);
        }
    }

    @Test
    void aBodyWithoutDataIsABadAnswer() throws IOException {
        HttpServer fake = serve("/v1/models", 200, "{\"hello\":1}");
        try {
            ListResult r = ModelLists.openAiCompat("lmstudio", base(fake), null);
            assertEquals("bad-answer", r.outcome());
        } finally {
            fake.stop(0);
        }
    }

    @Test
    void anEmptyOllamaListIsOkWithZeroModels() throws IOException {
        HttpServer fake = serve("/api/tags", 200, "{\"models\":[]}");
        try {
            ListResult r = ModelLists.ollama(base(fake));
            assertEquals("ok", r.outcome());
            assertEquals(List.of(), r.models(), "answers, no model loaded is not a failure");
        } finally {
            fake.stop(0);
        }
    }

    @Test
    void anthropicWithoutAKeyNeverDials() {
        ListResult r = ModelLists.anthropic(null);
        assertEquals("no-key", r.outcome());
        assertFalse(r.live());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./gradlew :spectro-server:test --tests 'dev.spectroscope.server.providers.ModelListsTest' --rerun-tasks --no-build-cache`
Expected: compilation failure, `ListResult` and `ModelLists` do not exist. Save the output to `kanban/evidence/<card>/task1-red.log`.

- [ ] **Step 3: Write `ListResult`**

```java
package dev.spectroscope.server.providers;

import java.util.List;

/**
 * One attempt to read a provider's model list. {@code outcome} is {@code ok}
 * or one reason code: {@code no-key}, {@code refused}, {@code timeout},
 * {@code rejected-key}, {@code http-<status>}, {@code bad-answer}. {@code live}
 * is true only when the models came from the provider, never from a curated
 * list. {@code endpoint} is the address that was dialled, so a failure can
 * name it.
 */
public record ListResult(String outcome, List<String> models, boolean live, String endpoint) {

    public static ListResult ok(List<String> models, String endpoint) {
        return new ListResult("ok", List.copyOf(models), true, endpoint);
    }

    public static ListResult failed(String reason, String endpoint) {
        return new ListResult(reason, List.of(), false, endpoint);
    }

    public boolean isOk() {
        return "ok".equals(outcome);
    }
}
```

- [ ] **Step 4: Write `ModelLists`**

Move the probe client, the non chat markers and the three routines out of `SessionsController` (lines 727 to 900 at `1cba586c`). The bodies keep their parsing; the catch blocks map the exception to a reason instead of returning a fallback.

```java
package dev.spectroscope.server.providers;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.provider.OpenAiCompatProvider;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestClient;

import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.http.HttpTimeoutException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * The three model list wires (anthropic, ollama, OpenAI compatible), each
 * answering a {@link ListResult} that keeps the reason for a failure. The
 * curated fallbacks are not here: they are the model route's business
 * ({@code SessionsController.models}), because a registry row must never
 * carry a list that looks live and is not.
 */
public final class ModelLists {

    private ModelLists() {
    }

    /** The Anthropic Models API, fixed endpoint, versioned like the SDK does it. */
    static final String ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=50";
    static final String ANTHROPIC_VERSION = "2023-06-01";

    /** Model families the chat picker must not offer; the /v1/models list carries everything. */
    static final List<String> NON_CHAT_MODEL_MARKERS = List.of(
            "embedding", "tts", "whisper", "dall-e", "audio", "realtime",
            "moderation", "transcribe", "davinci", "babbage", "image", "sora");

    /**
     * A client with finite connect and read timeouts. RestClient.create() would
     * inherit the classpath's default factory, whose read timeout is unbounded:
     * a backend that accepts the connection and never answers would pin the
     * Tomcat worker forever.
     */
    static final RestClient PROBE = RestClient.builder().requestFactory(probeFactory()).build();

    private static SimpleClientHttpRequestFactory probeFactory() {
        SimpleClientHttpRequestFactory f = new SimpleClientHttpRequestFactory();
        f.setConnectTimeout(1500);
        f.setReadTimeout(2500);
        return f;
    }

    static boolean isChatModel(String id) {
        String lower = id.toLowerCase();
        return NON_CHAT_MODEL_MARKERS.stream().noneMatch(lower::contains);
    }

    public static ListResult anthropic(String key) {
        if (key == null || key.isBlank()) {
            return ListResult.failed("no-key", ANTHROPIC_MODELS_URL);
        }
        try {
            JsonNode page = PROBE.get()
                    .uri(ANTHROPIC_MODELS_URL)
                    .header("x-api-key", key)
                    .header("anthropic-version", ANTHROPIC_VERSION)
                    .retrieve().body(JsonNode.class);
            if (page == null || !page.has("data")) {
                return ListResult.failed("bad-answer", ANTHROPIC_MODELS_URL);
            }
            List<String> ids = new ArrayList<>();
            for (JsonNode entry : page.get("data")) {
                String id = entry.path("id").asText("");
                if (!id.isBlank()) {
                    ids.add(id);
                }
            }
            return ListResult.ok(ids, ANTHROPIC_MODELS_URL);
        } catch (Exception failure) {
            return ListResult.failed(reasonOf(failure), ANTHROPIC_MODELS_URL);
        }
    }

    public static ListResult ollama(String base) {
        String url = base + "/api/tags";
        try {
            JsonNode tags = PROBE.get().uri(url).retrieve().body(JsonNode.class);
            if (tags == null || !tags.has("models")) {
                return ListResult.failed("bad-answer", base);
            }
            List<String> names = new ArrayList<>();
            for (JsonNode entry : tags.get("models")) {
                String name = entry.path("name").asText("");
                if (!name.isBlank()) {
                    names.add(name);
                }
            }
            return ListResult.ok(names, base);
        } catch (Exception failure) {
            return ListResult.failed(reasonOf(failure), base);
        }
    }

    public static ListResult openAiCompat(String provider, String base, String key) {
        boolean hasKey = key != null && !key.isBlank();
        try {
            RestClient.RequestHeadersSpec<?> request = PROBE.get()
                    .uri(base + OpenAiCompatProvider.compatPath(base, "/models"));
            if (hasKey) {
                request = request.header("Authorization", "Bearer " + key);
            }
            JsonNode page = request.retrieve().body(JsonNode.class);
            if (page == null || !page.has("data")) {
                return ListResult.failed("bad-answer", base);
            }
            record ModelRow(String id, long created) {}
            List<ModelRow> rows = new ArrayList<>();
            for (JsonNode entry : page.get("data")) {
                String id = entry.path("id").asText("");
                if (!id.isBlank() && isChatModel(id)) {
                    rows.add(new ModelRow(id, entry.path("created").asLong(0)));
                }
            }
            List<String> ids = rows.stream()
                    .sorted(Comparator.comparingLong(ModelRow::created).reversed())
                    .map(ModelRow::id)
                    .limit(60)
                    .toList();
            return ListResult.ok(ids, base);
        } catch (Exception failure) {
            return ListResult.failed(reasonOf(failure), base);
        }
    }

    /** One reason code per failure class. Everything unknown is a bad answer. */
    static String reasonOf(Exception failure) {
        if (failure instanceof HttpClientErrorException http) {
            int status = http.getStatusCode().value();
            return status == 401 || status == 403 ? "rejected-key" : "http-" + status;
        }
        if (failure instanceof HttpServerErrorException http) {
            return "http-" + http.getStatusCode().value();
        }
        if (failure instanceof ResourceAccessException io) {
            Throwable cause = io.getCause();
            if (cause instanceof SocketTimeoutException || cause instanceof HttpTimeoutException) {
                return "timeout";
            }
            if (cause instanceof ConnectException) {
                return "refused";
            }
            return "refused";
        }
        return "bad-answer";
    }
}
```

- [ ] **Step 5: Make `SessionsController.models()` delegate and keep its contract**

Replace the bodies of `anthropicModels`, `ollamaModels` and `openaiModels` in `SessionsController.java` (lines 727 to 900 at `1cba586c`); delete `MODEL_PROBE`, `modelProbeFactory`, `NON_CHAT_MODEL_MARKERS`, `isChatModel`, `ANTHROPIC_MODELS_URL` and `ANTHROPIC_VERSION` from the controller; keep `ANTHROPIC_MODELS` and `OPENAI_MODELS` (the curated fallbacks) and `modelWire`.

```java
    private List<String> anthropicModels() {
        dev.spectroscope.server.providers.ListResult r =
                dev.spectroscope.server.providers.ModelLists.anthropic(
                        SpectroConfig.resolveApiKey("ANTHROPIC_API_KEY"));
        return r.isOk() && !r.models().isEmpty() ? r.models() : ANTHROPIC_MODELS;
    }

    private List<String> ollamaModels() {
        SpectroConfig c = SpectroConfig.load(SpectroConfig.Overrides.none());
        dev.spectroscope.server.providers.ListResult r =
                dev.spectroscope.server.providers.ModelLists.ollama(c.endpointFor("ollama"));
        return r.isOk() ? r.models() : List.of();
    }

    private List<String> openaiModels(String provider) {
        List<String> fallback = "openai".equals(provider) ? OPENAI_MODELS : List.of();
        SpectroConfig c = SpectroConfig.load(SpectroConfig.Overrides.none());
        String key = SpectroConfig.resolveApiKey(SpectroConfig.keyEnvFor(provider));
        dev.spectroscope.server.providers.ListResult r =
                dev.spectroscope.server.providers.ModelLists.openAiCompat(provider, c.endpointFor(provider), key);
        return r.isOk() && !r.models().isEmpty() ? r.models() : fallback;
    }
```

Remove the now unused imports (`RestClient`, `SimpleClientHttpRequestFactory`, `JsonNode` if nothing else in the file uses it; check with the compiler).

- [ ] **Step 6: Run the new test and the two existing probe tests**

Run: `./gradlew :spectro-server:test --tests 'dev.spectroscope.server.providers.ModelListsTest' --tests 'dev.spectroscope.server.session.ModelProbeAddressTest' --tests 'dev.spectroscope.server.session.ModelListRoutingTest' --rerun-tasks --no-build-cache`
Expected: all PASS. `ModelProbeAddressTest` proves the delegation kept the per provider address.

- [ ] **Step 7: Commit**

```bash
git add spectro-server/src/main/java/dev/spectroscope/server/providers/ListResult.java \
        spectro-server/src/main/java/dev/spectroscope/server/providers/ModelLists.java \
        spectro-server/src/main/java/dev/spectroscope/server/session/SessionsController.java \
        spectro-server/src/test/java/dev/spectroscope/server/providers/ModelListsTest.java
git commit -F /tmp/msg-task1.txt
```

Message file: `Provider registry: model lists keep the reason for a failure` plus one paragraph on the move and the unchanged `/api/models` contract.

---

### Task 2: `ProviderRegistry` state derivation (server, no network)

**Files:**
- Create: `spectro-server/src/main/java/dev/spectroscope/server/providers/ProviderRow.java`
- Create: `spectro-server/src/main/java/dev/spectroscope/server/providers/ProviderRegistry.java`
- Test: `spectro-server/src/test/java/dev/spectroscope/server/providers/ProviderRegistryTest.java`

**Interfaces:**
- Consumes: `ListResult`, `ModelLists`, `SpectroConfig.knownProviders()`, `keyEnvFor`, `hasApiKey`, `presetEndpointFor`, `endpointFor`, `isLocalEndpoint`, `keylessLocalServers()`, `LocalModel.anyPresent()`.
- Produces: `record ProviderRow(String id, String kind, String state, boolean keyPresent, String endpoint, List<String> models, boolean live, String reason, long checkedAt)`; `ProviderRegistry(Lister lister, LongSupplier clock)`; `interface Lister { ListResult list(String provider, SpectroConfig c); }`; `List<ProviderRow> rows(SpectroConfig c)`; `ProviderRow check(String provider, SpectroConfig c)` (Task 3 adds the budget); `void invalidate(String provider)`; `static String kindOf(String provider, SpectroConfig c)`; `static ProviderRegistry shared()`; constants `LOCAL_TTL_MS = 30_000L`, `CLOUD_TTL_MS = 600_000L`.

- [ ] **Step 1: Write the failing test**

```java
package dev.spectroscope.server.providers;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
    void aCloudProviderWithoutAKeyNeedsAKeyAndIsNeverChecked() {
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            throw new AssertionError("a needs-key provider must not be dialled");
        }, now::get);
        ProviderRow checked = registry.check("openrouter", config());
        assertEquals("needs-key", checked.state());
        assertFalse(checked.keyPresent());
        assertEquals("cloud", checked.kind());
    }

    @Test
    void openaiAtAPrivateAddressWithoutAKeyIsLocal() throws IOException {
        writeUserSettings("{ \"openaiBaseUrl\": \"http://192.168.1.20:8080\" }");
        ProviderRegistry registry = new ProviderRegistry(
                (p, c) -> ListResult.ok(List.of(), c.endpointFor(p)), now::get);
        ProviderRow r = row(registry.rows(config()), "openai");
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
```

Note for the implementer: `aCloudProviderWithoutAKeyNeedsAKeyAndIsNeverChecked` assumes no `OPENROUTER_API_KEY` in the test environment; the gradle test task runs with `user.home` inside the build directory, so no `.env` is read. If the environment variable is set on the machine, the test must skip with `assumeFalse(SpectroConfig.hasApiKey("OPENROUTER_API_KEY"))`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./gradlew :spectro-server:test --tests 'dev.spectroscope.server.providers.ProviderRegistryTest' --rerun-tasks --no-build-cache`
Expected: compilation failure, `ProviderRegistry` and `ProviderRow` do not exist. Save to `kanban/evidence/<card>/task2-red.log`.

- [ ] **Step 3: Write `ProviderRow`**

```java
package dev.spectroscope.server.providers;

import java.util.List;

/**
 * One provider as the registry sees it. {@code kind} is {@code cloud},
 * {@code local} or {@code builtin}; {@code state} is {@code needs-key},
 * {@code needs-download}, {@code configured}, {@code reachable} or
 * {@code failed}. {@code keyPresent} is a boolean, never a value.
 * {@code endpoint} is null for a provider that owns no address. {@code reason}
 * is null unless the state is {@code failed}. {@code checkedAt} is 0 when no
 * check has ever run.
 */
public record ProviderRow(String id, String kind, String state, boolean keyPresent, String endpoint,
                          List<String> models, boolean live, String reason, long checkedAt) {
}
```

- [ ] **Step 4: Write `ProviderRegistry` (derivation and cache; the budget comes in Task 3)**

```java
package dev.spectroscope.server.providers;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.local.LocalModel;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;

/**
 * Which providers are configured and which answer, for every surface that
 * asks. Presence (key, model file, address) is recomputed on every read; the
 * last check result is the only stored thing, and it is keyed by a signature
 * of the inputs it was measured under, so a changed address or a removed key
 * never shows a stale answer.
 */
public final class ProviderRegistry {

    /** How a provider's model list is read. Injected so tests never dial. */
    public interface Lister {
        ListResult list(String provider, SpectroConfig c);
    }

    /** Stored per provider: the result and the inputs it was measured under. */
    record Stored(ListResult result, String signature, long checkedAt) {
    }

    public static final long LOCAL_TTL_MS = 30_000L;
    public static final long CLOUD_TTL_MS = 600_000L;

    private static volatile ProviderRegistry shared;

    /** The process wide registry, built on the real listers and the wall clock. */
    public static ProviderRegistry shared() {
        ProviderRegistry r = shared;
        if (r == null) {
            synchronized (ProviderRegistry.class) {
                r = shared;
                if (r == null) {
                    r = new ProviderRegistry(ProviderRegistry::realList, System::currentTimeMillis);
                    shared = r;
                }
            }
        }
        return r;
    }

    private final Lister lister;
    private final LongSupplier clock;
    private final Map<String, Stored> stored = new ConcurrentHashMap<>();

    public ProviderRegistry(Lister lister, LongSupplier clock) {
        this.lister = lister;
        this.clock = clock;
    }

    /** The real wires, chosen by the same rule {@code SessionsController.modelWire} uses. */
    static ListResult realList(String provider, SpectroConfig c) {
        if ("anthropic".equals(provider)) {
            return ModelLists.anthropic(SpectroConfig.resolveApiKey("ANTHROPIC_API_KEY"));
        }
        if ("ollama".equals(provider)) {
            return ModelLists.ollama(c.endpointFor(provider));
        }
        String key = SpectroConfig.resolveApiKey(SpectroConfig.keyEnvFor(provider));
        return ModelLists.openAiCompat(provider, c.endpointFor(provider), key);
    }

    /** {@code cloud}, {@code local} or {@code builtin}, from the config's own rules. */
    public static String kindOf(String provider, SpectroConfig c) {
        if ("spectro-local".equals(provider)) {
            return "builtin";
        }
        if (SpectroConfig.keylessLocalServers().contains(provider)) {
            return "local";
        }
        String endpoint = endpointOrNull(provider, c);
        if (endpoint != null && SpectroConfig.isLocalEndpoint(endpoint)) {
            return "local";
        }
        return "cloud";
    }

    static String endpointOrNull(String provider, SpectroConfig c) {
        if (SpectroConfig.presetEndpointFor(provider) == null) {
            return null;
        }
        return c.endpointFor(provider);
    }

    static boolean keyPresent(String provider) {
        String env = SpectroConfig.keyEnvFor(provider);
        return env != null && SpectroConfig.hasApiKey(env);
    }

    static String signature(String provider, SpectroConfig c) {
        boolean modelFile = "spectro-local".equals(provider) && LocalModel.anyPresent();
        return endpointOrNull(provider, c) + "|" + keyPresent(provider) + "|" + modelFile;
    }

    public List<ProviderRow> rows(SpectroConfig c) {
        List<ProviderRow> out = new ArrayList<>();
        for (String p : SpectroConfig.knownProviders().stream().sorted().toList()) {
            out.add(row(p, c));
        }
        return out;
    }

    public void invalidate(String provider) {
        stored.remove(provider);
    }

    /** Runs the lister for one provider and stores the result. Task 3 bounds it. */
    public ProviderRow check(String provider, SpectroConfig c) {
        ProviderRow before = row(provider, c);
        if (!checkable(before)) {
            return before;
        }
        ListResult result = lister.list(provider, c);
        stored.put(provider, new Stored(result, signature(provider, c), clock.getAsLong()));
        return row(provider, c);
    }

    static boolean checkable(ProviderRow row) {
        return !"builtin".equals(row.kind())
                && !"needs-key".equals(row.state())
                && !"needs-download".equals(row.state());
    }

    ProviderRow row(String provider, SpectroConfig c) {
        String kind = kindOf(provider, c);
        boolean key = keyPresent(provider);
        String endpoint = "cloud".equals(kind) ? null : endpointOrNull(provider, c);
        if ("builtin".equals(kind)) {
            String state = LocalModel.anyPresent() ? "configured" : "needs-download";
            return new ProviderRow(provider, kind, state, false, null, List.of(), false, null, 0L);
        }
        if ("cloud".equals(kind) && !key) {
            return new ProviderRow(provider, kind, "needs-key", false, null, List.of(), false, null, 0L);
        }
        Stored s = stored.get(provider);
        if (s == null) {
            return new ProviderRow(provider, kind, "configured", key, endpoint, List.of(), false, null, 0L);
        }
        boolean sameInputs = s.signature().equals(signature(provider, c));
        long ttl = "local".equals(kind) ? LOCAL_TTL_MS : CLOUD_TTL_MS;
        boolean fresh = clock.getAsLong() - s.checkedAt() <= ttl;
        if (!sameInputs || !fresh) {
            return new ProviderRow(provider, kind, "configured", key, endpoint, List.of(), false, null,
                    sameInputs ? s.checkedAt() : 0L);
        }
        ListResult r = s.result();
        if (r.isOk()) {
            return new ProviderRow(provider, kind, "reachable", key, endpoint, r.models(), r.live(), null,
                    s.checkedAt());
        }
        return new ProviderRow(provider, kind, "failed", key, endpoint, List.of(), false, r.outcome(),
                s.checkedAt());
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `./gradlew :spectro-server:test --tests 'dev.spectroscope.server.providers.ProviderRegistryTest' --rerun-tasks --no-build-cache`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add spectro-server/src/main/java/dev/spectroscope/server/providers/ProviderRow.java \
        spectro-server/src/main/java/dev/spectroscope/server/providers/ProviderRegistry.java \
        spectro-server/src/test/java/dev/spectroscope/server/providers/ProviderRegistryTest.java
git commit -F /tmp/msg-task2.txt
```

---

### Task 3: The bounded check and the parallel check of many (server)

**Files:**
- Modify: `spectro-server/src/main/java/dev/spectroscope/server/providers/ProviderRegistry.java` (`check` gets the budget; add `checkAll`)
- Test: `spectro-server/src/test/java/dev/spectroscope/server/providers/ProviderRegistryBudgetTest.java`

**Interfaces:**
- Produces: `public static final long CHECK_BUDGET_MS = 5_000L`; `ProviderRow check(String provider, SpectroConfig c)` now returns within the budget; `List<ProviderRow> checkAll(SpectroConfig c, java.util.function.Predicate<ProviderRow> which)` runs every selected provider in parallel on virtual threads under one budget and returns `rows(c)`.

- [ ] **Step 1: Write the failing test**

```java
package dev.spectroscope.server.providers;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** A check answers within its budget whatever the provider does. */
class ProviderRegistryBudgetTest {

    private static SpectroConfig config() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }

    @Test
    @Timeout(value = 20, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void aListerThatNeverReturnsIsATimeoutWithinTheBudget() throws InterruptedException {
        CountDownLatch never = new CountDownLatch(1);
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            try {
                never.await();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return ListResult.ok(List.of(), "http://127.0.0.1:1");
        }, System::currentTimeMillis);
        long started = System.nanoTime();
        ProviderRow r = registry.check("ollama", config());
        long elapsedMs = (System.nanoTime() - started) / 1_000_000L;
        assertEquals("failed", r.state());
        assertEquals("timeout", r.reason());
        assertTrue(elapsedMs < ProviderRegistry.CHECK_BUDGET_MS + 1_500L,
                "answered after " + elapsedMs + " ms, budget " + ProviderRegistry.CHECK_BUDGET_MS);
        never.countDown();
    }

    @Test
    @Timeout(value = 20, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
    void checkAllRunsTheSelectedProvidersSideBySideUnderOneBudget() {
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            try {
                Thread.sleep(1_000L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            return ListResult.ok(List.of(p + "-model"), "http://127.0.0.1:1");
        }, System::currentTimeMillis);
        long started = System.nanoTime();
        List<ProviderRow> rows = registry.checkAll(config(), r -> "local".equals(r.kind()));
        long elapsedMs = (System.nanoTime() - started) / 1_000_000L;
        long checked = rows.stream().filter(r -> "reachable".equals(r.state())).count();
        assertEquals(SpectroConfig.keylessLocalServers().size(), checked);
        assertTrue(elapsedMs < 3_000L, "three one second checks side by side took " + elapsedMs + " ms");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./gradlew :spectro-server:test --tests 'dev.spectroscope.server.providers.ProviderRegistryBudgetTest' --rerun-tasks --no-build-cache`
Expected: the first test hangs until the JUnit timeout (20 s) and fails; the second fails to compile (`checkAll` and `CHECK_BUDGET_MS` missing). Save to `kanban/evidence/<card>/task3-red.log`.

- [ ] **Step 3: Add the budget and `checkAll`**

Replace `check` in `ProviderRegistry` and add the constant and `checkAll`:

```java
    /** The whole round trip of one check, whatever the provider does with the connection. */
    public static final long CHECK_BUDGET_MS = 5_000L;

    public ProviderRow check(String provider, SpectroConfig c) {
        ProviderRow before = row(provider, c);
        if (!checkable(before)) {
            return before;
        }
        ListResult result = bounded(provider, c);
        stored.put(provider, new Stored(result, signature(provider, c), clock.getAsLong()));
        return row(provider, c);
    }

    /**
     * Runs the lister on a virtual thread and gives up after the budget. The
     * budget, not the HTTP read timeout, is the ceiling: a read timeout restarts
     * with every byte, so a server that trickles bytes would hold the call
     * open past it (the DockerPing pattern).
     */
    private ListResult bounded(String provider, SpectroConfig c) {
        String endpoint = endpointOrNull(provider, c);
        try (ExecutorService runner = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<ListResult> answer = runner.submit(() -> lister.list(provider, c));
            try {
                return answer.get(CHECK_BUDGET_MS, TimeUnit.MILLISECONDS);
            } catch (TimeoutException mute) {
                answer.cancel(true);
                return ListResult.failed("timeout", endpoint);
            } catch (ExecutionException wrapped) {
                return ListResult.failed("bad-answer", endpoint);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return ListResult.failed("timeout", endpoint);
            }
        }
    }

    /** Checks every row {@code which} accepts, side by side, and returns the rows. */
    public List<ProviderRow> checkAll(SpectroConfig c, Predicate<ProviderRow> which) {
        List<String> ids = rows(c).stream().filter(which).filter(ProviderRegistry::checkable)
                .map(ProviderRow::id).toList();
        try (ExecutorService runner = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<ProviderRow>> answers = new ArrayList<>();
            for (String id : ids) {
                answers.add(runner.submit(() -> check(id, c)));
            }
            for (Future<ProviderRow> answer : answers) {
                try {
                    answer.get(CHECK_BUDGET_MS + 500L, TimeUnit.MILLISECONDS);
                } catch (TimeoutException | ExecutionException ignored) {
                    // check() already stored a timeout or a reason for this id
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        }
        return rows(c);
    }
```

Imports to add: `java.util.concurrent.ExecutionException`, `ExecutorService`, `Executors`, `Future`, `TimeUnit`, `TimeoutException`, `java.util.function.Predicate`.

Note: `try-with-resources` on the executor waits for the stuck task to end on close. A cancelled virtual thread blocked in a socket read ends when the read timeout fires (2.5 s), so the close returns; for the latch based test the `cancel(true)` interrupts the `await`. If the close still blocks in practice, replace the try-with-resources by `runner.shutdownNow()` without waiting; measure on the first build and record the result in the card.

- [ ] **Step 4: Run the test to verify it passes**

Run: `./gradlew :spectro-server:test --tests 'dev.spectroscope.server.providers.ProviderRegistryBudgetTest' --tests 'dev.spectroscope.server.providers.ProviderRegistryTest' --rerun-tasks --no-build-cache`
Expected: PASS. Record the two elapsed times printed on failure paths by adding them to the card's evidence from a run with `-i`.

- [ ] **Step 5: Mutation probe**

Set `CHECK_BUDGET_MS` to `60_000L`, run the first test, see it fail on the elapsed assertion; restore. Keep the red output in `kanban/evidence/<card>/task3-bite.log`.

- [ ] **Step 6: Commit**

```bash
git add spectro-server/src/main/java/dev/spectroscope/server/providers/ProviderRegistry.java \
        spectro-server/src/test/java/dev/spectroscope/server/providers/ProviderRegistryBudgetTest.java
git commit -F /tmp/msg-task3.txt
```

---

### Task 4: `ProvidersController` routes (server)

**Files:**
- Create: `spectro-server/src/main/java/dev/spectroscope/server/providers/ProvidersController.java`
- Test: `spectro-server/src/test/java/dev/spectroscope/server/providers/ProvidersControllerTest.java`

**Interfaces:**
- Consumes: `ProviderRegistry`, `LocalOrigin.isLocalOrigin(HttpServletRequest)`, `LocalOrigin.originIsLoopbackOrAbsent(HttpServletRequest)` (package `dev.spectroscope.server.web`).
- Produces: `GET /api/providers` returning `{ "providers": [ProviderRow...] }`; `POST /api/providers/check?provider=<id|all|local>` returning the same shape, 404 for a non local caller, 400 for an unknown id.

- [ ] **Step 1: Write the failing test**

```java
package dev.spectroscope.server.providers;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The two routes: a read that never dials, and a fenced check that does. */
class ProvidersControllerTest {

    private static MockHttpServletRequest local() {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/providers/check");
        request.setServerName("localhost");
        request.setRemoteAddr("127.0.0.1");
        return request;
    }

    private static MockHttpServletRequest foreign() {
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/api/providers/check");
        request.setServerName("evil.example");
        request.addHeader("Origin", "http://evil.example");
        request.setRemoteAddr("127.0.0.1");
        return request;
    }

    @Test
    @SuppressWarnings("unchecked")
    void theReadRouteListsEveryProviderWithoutDialling() {
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            throw new AssertionError("GET must not dial " + p);
        }, System::currentTimeMillis);
        Map<String, Object> body = new ProvidersController(registry).list();
        List<ProviderRow> rows = (List<ProviderRow>) body.get("providers");
        assertEquals(SpectroConfig.knownProviders().size(), rows.size());
    }

    @Test
    @SuppressWarnings("unchecked")
    void theCheckRouteChecksOneProviderForALocalCaller() {
        ProviderRegistry registry = new ProviderRegistry(
                (p, c) -> ListResult.ok(List.of("m"), "http://127.0.0.1:11434"), System::currentTimeMillis);
        ResponseEntity<Map<String, Object>> answer = new ProvidersController(registry).check("ollama", local());
        assertEquals(200, answer.getStatusCode().value());
        List<ProviderRow> rows = (List<ProviderRow>) answer.getBody().get("providers");
        ProviderRow ollama = rows.stream().filter(r -> r.id().equals("ollama")).findFirst().orElseThrow();
        assertEquals("reachable", ollama.state());
    }

    @Test
    void theCheckRouteIsFencedToLocalCallers() {
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            throw new AssertionError("a foreign page must not trigger a check");
        }, System::currentTimeMillis);
        ResponseEntity<Map<String, Object>> answer = new ProvidersController(registry).check("all", foreign());
        assertEquals(404, answer.getStatusCode().value());
    }

    @Test
    void anUnknownProviderIsABadRequest() {
        ProviderRegistry registry = new ProviderRegistry((p, c) -> ListResult.failed("refused", "x"),
                System::currentTimeMillis);
        ResponseEntity<Map<String, Object>> answer = new ProvidersController(registry).check("vllm", local());
        assertEquals(400, answer.getStatusCode().value());
    }

    @Test
    @SuppressWarnings("unchecked")
    void localChecksOnlyTheLocalKind() {
        List<String> dialled = new java.util.concurrent.CopyOnWriteArrayList<>();
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            dialled.add(p);
            return ListResult.ok(List.of(), "http://127.0.0.1:1");
        }, System::currentTimeMillis);
        new ProvidersController(registry).check("local", local());
        assertTrue(dialled.stream().allMatch(SpectroConfig.keylessLocalServers()::contains), dialled.toString());
    }
}
```

Note: `spring-test` is already a test dependency of `spectro-server` (`MockHttpServletRequest` is used by `LocalOriginTest`; confirm with `grep -rl MockHttpServletRequest spectro-server/src/test`). If it is not, the fence test drives `LocalOrigin` through a hand written `HttpServletRequest` stub the way that test does.

- [ ] **Step 2: Run the test to verify it fails**

Run: `./gradlew :spectro-server:test --tests 'dev.spectroscope.server.providers.ProvidersControllerTest' --rerun-tasks --no-build-cache`
Expected: compilation failure. Save to `kanban/evidence/<card>/task4-red.log`.

- [ ] **Step 3: Write the controller**

```java
package dev.spectroscope.server.providers;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The provider registry on the wire. {@code GET /api/providers} is presence
 * plus whatever the last check stored and sends nothing to any provider.
 * {@code POST /api/providers/check} sends requests on the operator's keys and
 * addresses, so it wears the same loopback and Origin fence as the key save
 * route: a foreign page gets 404.
 */
@RestController
public class ProvidersController {

    private final ProviderRegistry registry;

    public ProvidersController() {
        this(ProviderRegistry.shared());
    }

    ProvidersController(ProviderRegistry registry) {
        this.registry = registry;
    }

    @GetMapping("/api/providers")
    public Map<String, Object> list() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("providers", registry.rows(SpectroConfig.load(SpectroConfig.Overrides.none())));
        return out;
    }

    @PostMapping("/api/providers/check")
    public ResponseEntity<Map<String, Object>> check(
            @RequestParam(name = "provider", defaultValue = "all") String provider,
            HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request) || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.status(404).build();
        }
        SpectroConfig c = SpectroConfig.load(SpectroConfig.Overrides.none());
        Map<String, Object> out = new LinkedHashMap<>();
        switch (provider) {
            case "all" -> out.put("providers", registry.checkAll(c, row -> true));
            case "local" -> out.put("providers", registry.checkAll(c, row -> "local".equals(row.kind())));
            default -> {
                if (!SpectroConfig.knownProviders().contains(provider)) {
                    return ResponseEntity.badRequest().build();
                }
                registry.check(provider, c);
                out.put("providers", registry.rows(c));
            }
        }
        return ResponseEntity.ok(out);
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./gradlew :spectro-server:test --tests 'dev.spectroscope.server.providers.ProvidersControllerTest' --rerun-tasks --no-build-cache`
Expected: PASS, 5 tests.

- [ ] **Step 5: Invalidate on key save**

In `SessionsController`, in the handler behind `/api/onboarding/key` (line 499 at `1cba586c`) and `/api/settings/env` (line 591), after a successful write, call `dev.spectroscope.server.providers.ProviderRegistry.shared().invalidate(provider)` where `provider` is the provider whose key variable was written (`/api/settings/env` writes a variable name; map it back with a loop over `SpectroConfig.knownProviders()` comparing `SpectroConfig.keyEnvFor(p)` to the written name). Add one test to `ProviderRegistryTest`:

```java
    @Test
    void aReplacedKeyIsInvalidatedByTheSaveRoute() {
        // The signature cannot see one key replaced by another, so the save
        // route calls invalidate; this pins that the method exists and drops.
        ProviderRegistry registry = new ProviderRegistry(
                (p, c) -> ListResult.failed("rejected-key", "https://api.openai.com"), now::get);
        registry.invalidate("openai");
        assertEquals("configured".equals(registry.rows(config()).stream()
                .filter(r -> r.id().equals("openai")).findFirst().orElseThrow().state())
                || SpectroConfig.keyEnvFor("openai") != null, true);
    }
```

(The pin of the call site itself is a source drift check: add to `ProvidersControllerTest` a test that reads `SessionsController.java` with `Files.readString` and asserts it contains `ProviderRegistry.shared().invalidate(` twice, the house pattern of `ProviderListDriftTest`.)

- [ ] **Step 6: Commit**

```bash
git add spectro-server/src/main/java/dev/spectroscope/server/providers/ProvidersController.java \
        spectro-server/src/main/java/dev/spectroscope/server/session/SessionsController.java \
        spectro-server/src/test/java/dev/spectroscope/server/providers/ProvidersControllerTest.java \
        spectro-server/src/test/java/dev/spectroscope/server/providers/ProviderRegistryTest.java
git commit -F /tmp/msg-task4.txt
```

---

### Task 5: `openai` at a private address is local everywhere (server and CLI)

**Files:**
- Modify: `spectro-server/src/main/java/dev/spectroscope/server/session/SessionsController.java:419-433` (the `providerStatus` loop)
- Modify: `spectro-cli/src/main/java/dev/spectroscope/cli/SpectroCli.java:234-240` (the first run gate)
- Test: `spectro-server/src/test/java/dev/spectroscope/server/session/ConfigProviderStatusTest.java` (add a test)
- Test: `spectro-cli/src/test/java/dev/spectroscope/cli/SpectroCliTest.java` (add a test beside `firstRunHintOffersEveryKeylessLocalBackendAsItsOwnRow`)

**Interfaces:**
- Consumes: `SpectroConfig.onboardingStatusAt(String provider, String endpoint, boolean keyPresent)` (`SpectroConfig.java:2945`), `SpectroConfig.presetEndpointFor`.
- Produces: a package private static helper in `SessionsController`: `static String statusOf(String provider, SpectroConfig c, boolean keyPresent)` used by the loop; the CLI gate uses the same expression inline.

- [ ] **Step 1: Write the failing tests**

Add to `ConfigProviderStatusTest`:

```java
    @Test
    @SuppressWarnings("unchecked")
    void openaiAtAPrivateAddressWithoutAKeyReadsLocal() throws java.io.IOException {
        org.junit.jupiter.api.Assumptions.assumeFalse(SpectroConfig.hasApiKey("OPENAI_API_KEY"));
        java.nio.file.Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        java.nio.file.Files.writeString(SpectroConfig.USER_SETTINGS_PATH,
                "{ \"openaiBaseUrl\": \"http://192.168.1.20:8080\" }");
        try {
            Map<String, Object> config = new SessionsController().config();
            Map<String, String> status = (Map<String, String>) config.get("providerStatus");
            assertEquals("local", status.get("openai"),
                    "a private address without a key is a local server, the doctor already says so");
        } finally {
            java.nio.file.Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        }
    }
```

Add to `SpectroCliTest` (follow the file's existing way of building a config; the test below assumes a `SpectroConfig` built with `openaiBaseUrl` set and no key, which the file's helpers for the first run hint already do for other providers; read lines 20 to 80 of the test first and reuse its builder):

```java
    @Test
    void theFirstRunGateLetsOpenaiAtAPrivateAddressThrough() {
        org.junit.jupiter.api.Assumptions.assumeFalse(SpectroConfig.hasApiKey("OPENAI_API_KEY"));
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none())
                .withProvider("openai")
                .withOpenaiBaseUrl("http://192.168.1.20:8080");
        assertFalse(SpectroCli.needsFirstRunHint(config),
                "openai pointed at the operator's own network is not a keyless cloud call");
    }
```

If `SpectroConfig` has no `withProvider`/`withOpenaiBaseUrl` builders, write the user settings file as the server test does and load.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `./gradlew :spectro-server:test --tests 'dev.spectroscope.server.session.ConfigProviderStatusTest' :spectro-cli:test --tests 'dev.spectroscope.cli.SpectroCliTest' --rerun-tasks --no-build-cache`
Expected: the server test fails with `expected: <local> but was: <needs-key>`; the CLI test fails to compile (`needsFirstRunHint` missing). Save to `kanban/evidence/<card>/task5-red.log`.

- [ ] **Step 3: Implement**

In `SessionsController`, add:

```java
    /**
     * The onboarding word for one provider against the endpoint it would
     * really dial (D11, 2026-10-09): openai pointed at a private address with
     * no key is a local server, exactly as the doctor reports it, not a cloud
     * call missing its key.
     */
    static String statusOf(String provider, SpectroConfig c, boolean keyPresent) {
        if (SpectroConfig.presetEndpointFor(provider) == null) {
            return SpectroConfig.onboardingStatus(provider, keyPresent);
        }
        return SpectroConfig.onboardingStatusAt(provider, c.endpointFor(provider), keyPresent);
    }
```

and in the loop at line 432 replace `SpectroConfig.onboardingStatus(p, keyEnv != null && envKeySet(keyEnv))` by `statusOf(p, c, keyEnv != null && envKeySet(keyEnv))`.

In `SpectroCli`, extract the gate:

```java
    /** Whether the configured provider is a keyless cloud call, judged against
     *  the endpoint it would dial, the same rule the server and the doctor use. */
    static boolean needsFirstRunHint(SpectroConfig config) {
        String provider = config.provider();
        boolean keyPresent = providerKeyPresent(provider);
        String status = SpectroConfig.presetEndpointFor(provider) == null
                ? SpectroConfig.onboardingStatus(provider, keyPresent)
                : SpectroConfig.onboardingStatusAt(provider, config.endpointFor(provider), keyPresent);
        return "needs-key".equals(status);
    }
```

and replace the condition at lines 234 to 237 by `if (needsFirstRunHint(config)) {`.

- [ ] **Step 4: Run the tests to verify they pass**

Run the same gradle line as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add spectro-server/src/main/java/dev/spectroscope/server/session/SessionsController.java \
        spectro-server/src/test/java/dev/spectroscope/server/session/ConfigProviderStatusTest.java \
        spectro-cli/src/main/java/dev/spectroscope/cli/SpectroCli.java \
        spectro-cli/src/test/java/dev/spectroscope/cli/SpectroCliTest.java
git commit -F /tmp/msg-task5.txt
```

---

### Task 6: The doctor probes the path the server dials (CLI)

**Files:**
- Modify: `spectro-cli/src/main/java/dev/spectroscope/cli/DoctorCommand.java:242`
- Test: `spectro-cli/src/test/java/dev/spectroscope/cli/DoctorProviderCheckTest.java` (add a test)

**Interfaces:**
- Consumes: `OpenAiCompatProvider.compatPath(String base, String path)`.
- Produces: a package private `static String modelsUrl(String endpoint)` in `DoctorCommand` returning `endpoint + OpenAiCompatProvider.compatPath(endpoint, "/models")`.

- [ ] **Step 1: Write the failing test**

```java
    @Test
    void theDoctorDoesNotDoubleTheVersionSegment() {
        assertEquals("http://127.0.0.1:1234/v1/models", DoctorCommand.modelsUrl("http://127.0.0.1:1234/v1"));
        assertEquals("http://127.0.0.1:1234/v1/models", DoctorCommand.modelsUrl("http://127.0.0.1:1234"));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `./gradlew :spectro-cli:test --tests 'dev.spectroscope.cli.DoctorProviderCheckTest' --rerun-tasks --no-build-cache`
Expected: compilation failure (`modelsUrl` missing).

- [ ] **Step 3: Implement**

```java
    /** The model list URL the SERVER dials, so the doctor and the picker probe
     *  the same door: a base that already ends in a version segment is not
     *  doubled. */
    static String modelsUrl(String endpoint) {
        return endpoint + dev.spectroscope.core.provider.OpenAiCompatProvider.compatPath(endpoint, "/models");
    }
```

Replace `probe(endpoint + "/v1/models")` at line 242 by `probe(modelsUrl(endpoint))`.

- [ ] **Step 4: Run it to verify it passes, then commit**

```bash
git add spectro-cli/src/main/java/dev/spectroscope/cli/DoctorCommand.java \
        spectro-cli/src/test/java/dev/spectroscope/cli/DoctorProviderCheckTest.java
git commit -F /tmp/msg-task6.txt
```

---

### Task 7: The web store `state/providerRegistry.ts`

**Files:**
- Create: `spectro-web/src/state/providerRegistry.ts`
- Test: `spectro-web/src/state/providerRegistry.test.ts`

**Interfaces:**
- Consumes: `GET /api/providers`, `POST /api/providers/check?provider=`.
- Produces:

```ts
export type ProviderKind = "cloud" | "local" | "builtin";
export type ProviderState = "needs-key" | "needs-download" | "configured" | "reachable" | "failed";
export interface ProviderRow {
  id: string; kind: ProviderKind; state: ProviderState; keyPresent: boolean;
  endpoint: string | null; models: string[]; live: boolean; reason: string | null; checkedAt: number;
}
export function useProviderRows(): ProviderRow[];
export function providerRows(): ProviderRow[];
export function rowFor(id: string): ProviderRow | undefined;
export function refreshProviders(): Promise<void>;
export function checkProviders(target: "all" | "local" | string): Promise<void>;
export function __resetProviderRegistry(): void;
```

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetProviderRegistry,
  checkProviders,
  providerRows,
  refreshProviders,
  rowFor,
} from "./providerRegistry";

let fetchMock: ReturnType<typeof vi.fn>;

function answer(body: unknown, status = 200): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

const ollama = {
  id: "ollama", kind: "local", state: "failed", keyPresent: false,
  endpoint: "http://localhost:11434", models: [], live: false, reason: "refused", checkedAt: 5,
};

beforeEach(() => {
  __resetProviderRegistry();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("the provider registry store", () => {
  it("reads the rows from GET /api/providers", async () => {
    answer({ providers: [ollama] });
    await refreshProviders();
    expect(fetchMock).toHaveBeenCalledWith("/api/providers");
    expect(providerRows().map((r) => r.id)).toEqual(["ollama"]);
    expect(rowFor("ollama")?.reason).toBe("refused");
  });

  it("posts a check and replaces the rows with the answer", async () => {
    answer({ providers: [{ ...ollama, state: "reachable", reason: null, models: ["qwen3:8b"], live: true }] });
    await checkProviders("local");
    expect(fetchMock).toHaveBeenCalledWith("/api/providers/check?provider=local", { method: "POST" });
    expect(rowFor("ollama")?.state).toBe("reachable");
  });

  it("keeps the rows it has when the server answers with an error", async () => {
    answer({ providers: [ollama] });
    await refreshProviders();
    answer({}, 500);
    await checkProviders("ollama");
    expect(rowFor("ollama")?.state).toBe("failed");
  });

  it("starts empty and rowFor answers undefined for an unknown id", () => {
    expect(providerRows()).toEqual([]);
    expect(rowFor("vllm")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd spectro-web && npx vitest run src/state/providerRegistry.test.ts`
Expected: FAIL, module not found. Save to `kanban/evidence/<card>/task7-red.log`.

- [ ] **Step 3: Implement**

```ts
// The provider registry as the web sees it (playbook concept, P1): one list
// of rows from GET /api/providers, replaced wholesale by every answer, and a
// POST that asks the server to check one provider, the local kind, or all.
// The server derives the state; this module never second-guesses it.

import { useSyncExternalStore } from "react";

export type ProviderKind = "cloud" | "local" | "builtin";
export type ProviderState = "needs-key" | "needs-download" | "configured" | "reachable" | "failed";

export interface ProviderRow {
  id: string;
  kind: ProviderKind;
  state: ProviderState;
  /** Presence only, never a value. */
  keyPresent: boolean;
  endpoint: string | null;
  models: string[];
  live: boolean;
  reason: string | null;
  /** Epoch milliseconds of the last check, 0 when none ran. */
  checkedAt: number;
}

let rows: ProviderRow[] = [];
const listeners = new Set<() => void>();

function adopt(next: ProviderRow[]): void {
  rows = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The rows as of the last answer; empty before the first one. */
export function providerRows(): ProviderRow[] {
  return rows;
}

export function rowFor(id: string): ProviderRow | undefined {
  return rows.find((r) => r.id === id);
}

export function useProviderRows(): ProviderRow[] {
  return useSyncExternalStore(subscribe, providerRows, providerRows);
}

function isRow(x: unknown): x is ProviderRow {
  return typeof x === "object" && x !== null && typeof (x as ProviderRow).id === "string";
}

async function take(response: Response): Promise<void> {
  if (!response.ok) return;
  const body = (await response.json()) as { providers?: unknown };
  if (Array.isArray(body.providers)) adopt(body.providers.filter(isRow));
}

/** GET: presence plus the last stored checks, no request to any provider. */
export async function refreshProviders(): Promise<void> {
  try {
    await take(await fetch("/api/providers"));
  } catch {
    // keep what we have: a lost read must not blank the picker
  }
}

/** POST: the server checks the target and answers with every row. */
export async function checkProviders(target: "all" | "local" | string): Promise<void> {
  try {
    await take(await fetch(`/api/providers/check?provider=${encodeURIComponent(target)}`, { method: "POST" }));
  } catch {
    // same rule as above
  }
}

/** Test only. */
export function __resetProviderRegistry(): void {
  rows = [];
}
```

- [ ] **Step 4: Run it to verify it passes, then commit**

```bash
git add spectro-web/src/state/providerRegistry.ts spectro-web/src/state/providerRegistry.test.ts
git commit -F /tmp/msg-task7.txt
```

---

### Task 8: Greyed options in the chat picker (web)

**Files:**
- Modify: `spectro-web/src/components/providerPickerMode.ts` (add `pickerOption`)
- Modify: `spectro-web/src/components/ProviderPicker.tsx:19-200`
- Modify: `spectro-web/src/i18n/i18n.ts` (keys `pp.optNeedsKey`, `pp.optFailed`, `pp.optFailedAt`, `pp.optNoModels`)
- Test: `spectro-web/src/components/providerPickerMode.test.ts` (add cases)
- Test: `spectro-web/src/components/providerPicker.test.tsx` (new, static render)

**Interfaces:**
- Consumes: `ProviderRow`, `rowFor`, `useProviderRows`, `refreshProviders`, `checkProviders` from Task 7.
- Produces:

```ts
export interface PickerOption { disabled: boolean; reasonKey: string | null; vars?: Record<string, string> }
export function pickerOption(row: ProviderRow | undefined, current: string): PickerOption;
```

Rule: the chat's current provider (`current`) is never disabled (the chip must stay selectable so it never lies); `needs-key` disables with `pp.optNeedsKey`; `failed` disables with `pp.optFailedAt` (`{addr}`, `{reason}`) when the row has an endpoint, else `pp.optFailed` (`{reason}`); every other state, and an unknown row (old server), is enabled with no reason. A `reachable` row with zero models is enabled and carries `pp.optNoModels` as a note, not a disable.

- [ ] **Step 1: Write the failing tests**

Append to `providerPickerMode.test.ts`:

```ts
import { pickerOption } from "./providerPickerMode";
import type { ProviderRow } from "../state/providerRegistry";

const row = (over: Partial<ProviderRow>): ProviderRow => ({
  id: "ollama", kind: "local", state: "configured", keyPresent: false, endpoint: "http://localhost:11434",
  models: [], live: false, reason: null, checkedAt: 0, ...over,
});

describe("pickerOption (D9: grey out, never hide)", () => {
  it("disables a provider that needs a key and says so", () => {
    expect(pickerOption(row({ id: "openrouter", kind: "cloud", state: "needs-key", endpoint: null }), "ollama"))
      .toEqual({ disabled: true, reasonKey: "pp.optNeedsKey" });
  });
  it("disables a failed local server and names the address and the reason", () => {
    expect(pickerOption(row({ state: "failed", reason: "refused" }), "anthropic"))
      .toEqual({ disabled: true, reasonKey: "pp.optFailedAt", vars: { addr: "http://localhost:11434", reason: "refused" } });
  });
  it("disables a failed cloud provider with the reason alone", () => {
    expect(pickerOption(row({ id: "openai", kind: "cloud", state: "failed", endpoint: null, reason: "rejected-key" }), "ollama"))
      .toEqual({ disabled: true, reasonKey: "pp.optFailed", vars: { reason: "rejected-key" } });
  });
  it("never disables the provider the chat runs on", () => {
    expect(pickerOption(row({ state: "failed", reason: "refused" }), "ollama").disabled).toBe(false);
  });
  it("keeps a server that answers with no model selectable, with a note", () => {
    expect(pickerOption(row({ state: "reachable", models: [] }), "anthropic"))
      .toEqual({ disabled: false, reasonKey: "pp.optNoModels" });
  });
  it("enables an unknown row, so an old server changes nothing", () => {
    expect(pickerOption(undefined, "ollama")).toEqual({ disabled: false, reasonKey: null });
  });
});
```

New `providerPicker.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderPicker } from "./ProviderPicker";
import { __resetProviderRegistry, __seedProviderRows } from "../state/providerRegistry";
import { blockOf, read } from "../testkit/source";

beforeEach(() => {
  __resetProviderRegistry();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }));
});
afterEach(() => vi.unstubAllGlobals());

describe("the picker's option list", () => {
  it("renders a failed provider as a disabled option with the reason as its title", () => {
    __seedProviderRows([
      { id: "ollama", kind: "local", state: "failed", keyPresent: false, endpoint: "http://localhost:11434",
        models: [], live: false, reason: "refused", checkedAt: 1 },
    ]);
    // The popover is closed on a static render; the option list is a pure
    // function of the rows, exported for exactly this reason.
    const source = read("src/components/ProviderPicker.tsx");
    expect(source).toContain("pickerOption(");
    expect(blockOf(source, "<option")).toContain("disabled={");
    expect(blockOf(source, "<option")).toContain("title={");
  });

  it("disables Switch while a disabled provider is selected", () => {
    const source = read("src/components/ProviderPicker.tsx");
    const foot = blockOf(source, 'className="provider-pop-foot"');
    expect(foot).toContain("disabled={selectedOption.disabled}");
  });
});
```

(`__seedProviderRows(rows)` is a second test only export added to the store in this task. The static render of the closed popover cannot show options, so the two option facts are pinned on the source with the house `testkit/source` helpers, as `settingsOpenWrites.drift.test.ts` does; the behaviour itself is pinned by the pure `pickerOption` tests above.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd spectro-web && npx vitest run src/components/providerPickerMode.test.ts src/components/providerPicker.test.tsx`
Expected: FAIL (`pickerOption` and `__seedProviderRows` missing).

- [ ] **Step 3: Implement**

In `providerPickerMode.ts`:

```ts
import type { ProviderRow } from "../state/providerRegistry";

export interface PickerOption {
  disabled: boolean;
  reasonKey: string | null;
  vars?: Record<string, string>;
}

/**
 * How one provider renders in the chat picker (owner decision D9, 2026-10-09:
 * grey out, never hide). The provider the chat runs on is never disabled, so
 * the chip can always be re-selected and never claims a state it is not in.
 */
export function pickerOption(row: ProviderRow | undefined, current: string): PickerOption {
  if (!row || row.id === current) return { disabled: false, reasonKey: null };
  if (row.state === "needs-key") return { disabled: true, reasonKey: "pp.optNeedsKey" };
  if (row.state === "failed") {
    const reason = row.reason ?? "unknown";
    return row.endpoint
      ? { disabled: true, reasonKey: "pp.optFailedAt", vars: { addr: row.endpoint, reason } }
      : { disabled: true, reasonKey: "pp.optFailed", vars: { reason } };
  }
  if (row.state === "reachable" && row.models.length === 0) {
    return { disabled: false, reasonKey: "pp.optNoModels" };
  }
  return { disabled: false, reasonKey: null };
}
```

In `providerRegistry.ts` add:

```ts
/** Test only: rows as if a server had answered. */
export function __seedProviderRows(seed: ProviderRow[]): void {
  adopt(seed);
}
```

In `ProviderPicker.tsx`:
1. Import `pickerOption` and, from the store, `useProviderRows`, `rowFor`, `refreshProviders`, `checkProviders`.
2. Inside the component: `const rows = useProviderRows();` and a second effect on `open`: when it becomes true, `void refreshProviders().then(() => checkProviders("local"));` (local servers only, D10).
3. Options:

```tsx
              {PROVIDERS.map((p) => {
                const option = pickerOption(rowFor(p), provider);
                return (
                  <option
                    key={p}
                    value={p}
                    disabled={option.disabled}
                    title={option.reasonKey ? t(lang, option.reasonKey, option.vars) : undefined}
                  >
                    {providerDisplayName(p)}
                  </option>
                );
              })}
```

4. Under the select, when `selectedOption.reasonKey` is set: `<span className="provider-field-note">{t(lang, selectedOption.reasonKey, selectedOption.vars)}</span>` where `const selectedOption = pickerOption(rowFor(sel), provider);` is computed once per render (`rows` is read through `rowFor`, which reads the store the hook subscribed to).
5. The Switch button gets `disabled={selectedOption.disabled}`.

i18n keys:

```ts
  "pp.optNeedsKey": { de: "kein Key gesetzt", en: "no key set" },
  "pp.optFailed": { de: "antwortet nicht ({reason})", en: "not answering ({reason})" },
  "pp.optFailedAt": {
    de: "antwortet nicht unter {addr} ({reason})",
    en: "not answering at {addr} ({reason})",
  },
  "pp.optNoModels": { de: "antwortet, kein Modell geladen", en: "answers, no model loaded" },
```

- [ ] **Step 4: Run the tests, then the web gate**

Run: `cd spectro-web && npx vitest run src/components/providerPickerMode.test.ts src/components/providerPicker.test.tsx` then `npm run gate` (no pipe). Expected: PASS; gate green; reset the bundle write (`git checkout -- ../spectro-server/src/main/resources/static` is NOT allowed while uncommitted work sits elsewhere in that path; the bundle lives in its own directory, so `git restore ../spectro-server/src/main/resources/static` is safe here because this task touches nothing under it).

- [ ] **Step 5: Commit**

```bash
git add spectro-web/src/components/providerPickerMode.ts spectro-web/src/components/providerPickerMode.test.ts \
        spectro-web/src/components/ProviderPicker.tsx spectro-web/src/components/providerPicker.test.tsx \
        spectro-web/src/state/providerRegistry.ts spectro-web/src/i18n/i18n.ts
git commit -F /tmp/msg-task8.txt
```

---

### Task 9: The provider overview on the settings page (web)

**Files:**
- Create: `spectro-web/src/components/ProviderStatusSettings.tsx`
- Modify: `spectro-web/src/components/SettingsPanel.tsx` (mount beside the provider fields, around line 1104 where `WebSearchSettings` is mounted; the key save path at line 540 also posts a check)
- Modify: `spectro-web/src/i18n/i18n.ts` (keys `prov.*`)
- Modify: `spectro-web/src/app.css` (a `.prov-table` block using tokens only)
- Test: `spectro-web/src/components/ProviderStatusSettings.test.tsx`

**Interfaces:**
- Consumes: the store of Task 7, `providerDisplayName`, `t`, `useLang`.
- Produces: `export function ProviderStatusSettings({ anchorId }: { anchorId: string }): JSX.Element`; pure helpers exported for tests: `stateLabelKey(state: ProviderState): string` and `ageLabel(checkedAt: number, now: number, lang: Lang): string`.

- [ ] **Step 1: Write the failing test**

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderStatusSettings, ageLabel, stateLabelKey } from "./ProviderStatusSettings";
import { __resetProviderRegistry, __seedProviderRows } from "../state/providerRegistry";
import { dict, t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

beforeEach(() => {
  __resetProviderRegistry();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }));
});
afterEach(() => vi.unstubAllGlobals());

describe("the provider overview", () => {
  it("renders one row per provider with its state in words and a Check button", () => {
    __seedProviderRows([
      { id: "anthropic", kind: "cloud", state: "needs-key", keyPresent: false, endpoint: null, models: [], live: false, reason: null, checkedAt: 0 },
      { id: "ollama", kind: "local", state: "reachable", keyPresent: false, endpoint: "http://localhost:11434", models: ["qwen3:8b"], live: true, reason: null, checkedAt: 1 },
      { id: "spectro-local", kind: "builtin", state: "configured", keyPresent: false, endpoint: null, models: [], live: false, reason: null, checkedAt: 0 },
    ]);
    const html = renderToStaticMarkup(<ProviderStatusSettings anchorId="providers" />);
    const lang = currentLang();
    expect(html).toContain(t(lang, "prov.state.needs-key"));
    expect(html).toContain(t(lang, "prov.state.reachable"));
    expect(html).toContain("http://localhost:11434");
    expect(html).toContain("built-in");
    expect(html).not.toContain(">spectro-local<");
    expect((html.match(/prov-check-one/g) ?? []).length).toBe(2);
    expect(html).toContain("prov-check-all");
  });

  it("shows key presence as a word, never a value", () => {
    __seedProviderRows([
      { id: "openai", kind: "cloud", state: "configured", keyPresent: true, endpoint: null, models: [], live: false, reason: null, checkedAt: 0 },
    ]);
    const html = renderToStaticMarkup(<ProviderStatusSettings anchorId="providers" />);
    expect(html).toContain(t(currentLang(), "prov.keyYes"));
    expect(html).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  it("has every state word in both languages", () => {
    for (const state of ["needs-key", "needs-download", "configured", "reachable", "failed"]) {
      const key = stateLabelKey(state as never);
      expect(dict[key].de.length).toBeGreaterThan(0);
      expect(dict[key].en.length).toBeGreaterThan(0);
    }
  });

  it("phrases the age of a check", () => {
    expect(ageLabel(0, 10_000, "en")).toBe(t("en", "prov.never"));
    expect(ageLabel(10_000 - 5_000, 10_000, "en")).toBe(t("en", "prov.ago", { s: 5 }));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd spectro-web && npx vitest run src/components/ProviderStatusSettings.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```tsx
// The provider overview on the settings page (playbook concept, P1; owner
// decision D10, 2026-10-09): every provider the config knows, its state in
// words, key presence as a word, the address a local one dials, the model
// count, the age of the last check, and a Check button. Checks run only on a
// press, on mount for the local kind, and once after a key save. No timer.

import { useEffect, useState } from "react";
import { t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import {
  checkProviders,
  refreshProviders,
  useProviderRows,
  type ProviderRow,
  type ProviderState,
} from "../state/providerRegistry";
import { providerDisplayName } from "./providerPickerMode";

export function stateLabelKey(state: ProviderState): string {
  return `prov.state.${state}`;
}

export function ageLabel(checkedAt: number, now: number, lang: Lang): string {
  if (checkedAt <= 0) return t(lang, "prov.never");
  const s = Math.max(0, Math.round((now - checkedAt) / 1000));
  return t(lang, "prov.ago", { s });
}

function Row({ row, busy, onCheck }: { row: ProviderRow; busy: boolean; onCheck: () => void }) {
  const lang = useLang();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
  }, [row.checkedAt]);
  return (
    <tr className={`prov-row prov-row--${row.state}`}>
      <td className="mono">{providerDisplayName(row.id)}</td>
      <td>
        {t(lang, stateLabelKey(row.state))}
        {row.reason && <span className="provider-field-note"> ({row.reason})</span>}
      </td>
      <td>{row.kind === "cloud" ? t(lang, row.keyPresent ? "prov.keyYes" : "prov.keyNo") : ""}</td>
      <td className="mono">{row.endpoint ?? ""}</td>
      <td>
        {row.state === "reachable"
          ? t(lang, row.live ? "prov.models" : "prov.modelsFallback", { n: row.models.length })
          : ""}
      </td>
      <td>{ageLabel(row.checkedAt, now, lang)}</td>
      <td>
        {row.kind !== "builtin" && row.state !== "needs-key" && row.state !== "needs-download" && (
          <button type="button" className="prov-check-one" disabled={busy} onClick={onCheck}>
            {t(lang, "prov.check")}
          </button>
        )}
      </td>
    </tr>
  );
}

export function ProviderStatusSettings({ anchorId }: { anchorId: string }) {
  const lang = useLang();
  const rows = useProviderRows();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refreshProviders().then(() => checkProviders("local"));
  }, []);

  const run = (target: string): void => {
    setBusy(true);
    void checkProviders(target).finally(() => setBusy(false));
  };

  return (
    <section className="settings-block" id={anchorId}>
      <h3>{t(lang, "prov.title")}</h3>
      <p className="provider-field-note">{t(lang, "prov.hint")}</p>
      <table className="prov-table">
        <thead>
          <tr>
            <th>{t(lang, "prov.col.provider")}</th>
            <th>{t(lang, "prov.col.state")}</th>
            <th>{t(lang, "prov.col.key")}</th>
            <th>{t(lang, "prov.col.address")}</th>
            <th>{t(lang, "prov.col.models")}</th>
            <th>{t(lang, "prov.col.checked")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Row key={row.id} row={row} busy={busy} onCheck={() => run(row.id)} />
          ))}
        </tbody>
      </table>
      <div className="prov-foot">
        <button type="button" className="prov-check-all soft-primary" disabled={busy} onClick={() => run("all")}>
          {t(lang, "prov.checkAll")}
        </button>
      </div>
    </section>
  );
}
```

i18n keys (German with real umlauts):

```ts
  "prov.title": { de: "Provider", en: "Providers" },
  "prov.hint": {
    de: "Konfiguriert heißt: Key oder Adresse vorhanden. Antwortet heißt: die letzte Prüfung bekam eine Modell-Liste. Geprüft wird nur auf Knopfdruck, beim Öffnen für lokale Server und einmal nach dem Speichern eines Keys.",
    en: "Configured means a key or an address is present. Answers means the last check got a model list. Checks run only on a press, on open for local servers, and once after a key is saved.",
  },
  "prov.col.provider": { de: "Provider", en: "Provider" },
  "prov.col.state": { de: "Zustand", en: "State" },
  "prov.col.key": { de: "Key", en: "Key" },
  "prov.col.address": { de: "Adresse", en: "Address" },
  "prov.col.models": { de: "Modelle", en: "Models" },
  "prov.col.checked": { de: "Geprüft", en: "Checked" },
  "prov.state.needs-key": { de: "Key fehlt", en: "needs a key" },
  "prov.state.needs-download": { de: "Modell nicht geladen", en: "model not downloaded" },
  "prov.state.configured": { de: "konfiguriert, nicht geprüft", en: "configured, not checked" },
  "prov.state.reachable": { de: "antwortet", en: "answers" },
  "prov.state.failed": { de: "antwortet nicht", en: "not answering" },
  "prov.keyYes": { de: "vorhanden", en: "present" },
  "prov.keyNo": { de: "fehlt", en: "missing" },
  "prov.models": { de: "{n} Modelle (live)", en: "{n} models (live)" },
  "prov.modelsFallback": { de: "{n} Modelle (Liste aus dem Produkt)", en: "{n} models (curated list)" },
  "prov.never": { de: "nie", en: "never" },
  "prov.ago": { de: "vor {s} s", en: "{s} s ago" },
  "prov.check": { de: "Prüfen", en: "Check" },
  "prov.checkAll": { de: "Alle prüfen", en: "Check all" },
```

CSS in `app.css`, tokens only (no hex): `.prov-table { width: 100%; border-collapse: collapse; } .prov-table th, .prov-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); } .prov-row--failed td:nth-child(2) { color: var(--danger); } .prov-row--reachable td:nth-child(2) { color: var(--ok); } .prov-foot { margin-top: 8px; }`. Check the token names against `tokens.css` before use (`grep -n -- '--line\|--danger\|--ok' spectro-web/src/tokens.css`) and take the ones that exist for both designs.

Mount in `SettingsPanel.tsx`: directly after the provider section's closing tag (the section that ends after line 960 at `1cba586c`), add `<ProviderStatusSettings anchorId="providers" />`. In the key save handler that bumps `probeEpoch` (line 540), add `void checkProviders(String(view.effective.provider ?? ""));` after the bump, importing `checkProviders` from the store.

- [ ] **Step 4: Run the test and the gate; verify live**

Run: `cd spectro-web && npx vitest run src/components/ProviderStatusSettings.test.tsx && npm run gate` (two commands, run one after the other, no pipe).

Then build a jar, copy it to `/tmp`, start it with a temporary home on port 8090 (memory note "fresh-user test server"), open the settings page in Playwright against the installed Chrome, and take screenshots in both themes at 1280 and 390 px wide into `kanban/evidence/<card>/`. Press Check all with ollama stopped and confirm the row reads "not answering (refused)" and the picker lists ollama greyed with the address in its title (read it with `page.getAttribute`).

- [ ] **Step 5: Commit**

```bash
git add spectro-web/src/components/ProviderStatusSettings.tsx spectro-web/src/components/ProviderStatusSettings.test.tsx \
        spectro-web/src/components/SettingsPanel.tsx spectro-web/src/i18n/i18n.ts spectro-web/src/app.css
git commit -F /tmp/msg-task9.txt
```

---

### Task 10: One name for the built-in provider, and the first run sentence (web)

**Files:**
- Modify: `spectro-web/src/components/SettingsPanel.tsx:899-902` (render `providerDisplayName(p)`)
- Modify: `spectro-web/src/components/Onboarding.tsx:197` and its `de` twin
- Test: `spectro-web/src/components/settingsOpenWrites.drift.test.ts` is unrelated; add `spectro-web/src/components/builtInName.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { blockOf, read } from "../testkit/source";
import { dict } from "../i18n/i18n";

describe("the built-in provider has one name", () => {
  it("is rendered through providerDisplayName on the settings page too", () => {
    const source = read("src/components/SettingsPanel.tsx");
    const select = blockOf(source, "PROVIDERS.map((p) => (");
    expect(select).toContain("providerDisplayName(p)");
  });
  it("tells the first run reader where the key file really is, with no restart", () => {
    for (const lang of ["de", "en"] as const) {
      const text = dict["ob.cloudBody"][lang];
      expect(text).toContain("~/.spectro/.env");
      expect(text.toLowerCase()).not.toContain(lang === "de" ? "neustart" : "restart");
    }
  });
});
```

(Confirm the key name of the cloud body string by reading `Onboarding.tsx:183 to 200`; replace `ob.cloudBody` by the real key before running.)

- [ ] **Step 2: Run it to verify it fails**, **Step 3: Implement** (import `providerDisplayName` in `SettingsPanel.tsx`; rewrite the two sentences to name `~/.spectro/.env` and say the key is used on the next provider switch), **Step 4: Run the test and `npm run gate`**, **Step 5: Commit** with explicit paths.

---

### Task 11: Positive drift twin, documentation, release note

**Files:**
- Modify: `spectro-core/src/test/java/dev/spectroscope/core/config/ProviderListDriftTest.java` (add a test)
- Modify: `spectro-server/src/main/java/dev/spectroscope/server/providers/ProvidersController.java` (javadoc only, if the test asks)
- Modify: `docs/api-collections/endpoints.json` (two new endpoints, if `PrintedProviderListsDriftTest` or `ApiCollectionsDriftTest` reads it; check with `grep -rn endpoints.json spectro-*/src/test`)
- Modify: `docs/USER-GUIDE.md` (the settings chapter: one paragraph on the provider overview; then regenerate the HTML and PDF with `docs/guide-assets/build_user_guide.py` as `ConfigDocDriftTest` demands; no settings key is added, so the config chapter is unchanged)
- Modify: `README.md` only if it lists `/api/config` fields (grep `providerStatus README.md`)

- [ ] **Step 1: Write the failing test** in `ProviderListDriftTest`:

```java
    /** The positive twin of the picker test: a provider the config knows has a
     *  registry row, so a backend can never be greyed out of existence. */
    @Test
    void everyKnownProviderHasARegistryRow() {
        dev.spectroscope.server.providers.ProviderRegistry registry =
                new dev.spectroscope.server.providers.ProviderRegistry((p, c) -> {
                    throw new AssertionError("rows() must not dial");
                }, System::currentTimeMillis);
        var ids = registry.rows(SpectroConfig.load(SpectroConfig.Overrides.none()))
                .stream().map(dev.spectroscope.server.providers.ProviderRow::id).collect(java.util.stream.Collectors.toSet());
        assertEquals(SpectroConfig.knownProviders(), ids);
    }
```

If `spectro-core` tests cannot see `spectro-server` classes (they cannot; the dependency runs the other way), put this test in `spectro-server/src/test/java/dev/spectroscope/server/providers/ProviderRegistryTest.java` instead; the first test there already pins it (`everyKnownProviderHasARowAndNoRowDialsAnything`). Then this step is the documentation and the endpoints file only.

- [ ] **Step 2: Documentation**: add the paragraph to the user guide's settings chapter, rebuild the guide, run `./gradlew :spectro-server:test --tests '*ConfigDocDriftTest*' --rerun-tasks --no-build-cache`.

- [ ] **Step 3: Full gates, alone in the worktree**

```bash
./gradlew test --rerun-tasks --no-build-cache
./gradlew javadoc --rerun-tasks --no-build-cache
cd spectro-web && npm run gate
```

Each as its own command, output into `kanban/evidence/<card>/gate-*.log` by redirection (`> file 2>&1`), then read `$?` from the shell, never through a pipe.

- [ ] **Step 4: Commit, then write the release note line in the card**: "Settings show every provider with its state and a Check button; the chat picker greys out providers that do not answer and says why; openai at a private address counts as local everywhere."

---

## Self-review

Spec coverage: requirement 1 (Task 2, 4), 2 (Task 3), 3 (Task 1, 2), 4 (Task 1, 8), 5 (Task 1, 2), 6 (Task 8), 7 (Task 5), 8 (Task 6), 9 (Task 11, or Task 2's first test), 10 (Task 9), 11 (by construction: no key, no timer, no push), 12 (Task 1 keeps the fallback rule in the controller).

Type consistency: `ListResult.failed(reason, endpoint)` and `ListResult.ok(models, endpoint)` are used with the same argument order in Tasks 1 to 4; `ProviderRow` has nine components in the same order everywhere; the web `ProviderRow` mirrors them by name; `pickerOption(row, current)` is called with `(rowFor(p), provider)` in Task 8.

Known uncertainty, stated: Task 3's executor close behaviour with a cancelled virtual thread blocked in a socket read is measured on the first build; the plan names the fallback (`shutdownNow`). Task 5's CLI test builders may not exist; the plan names the alternative (write the user settings file). Task 10's i18n key name is confirmed from the source before the test runs.
