package dev.spectroscope.server.providers;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The two routes: a read that never dials, and a fenced check that does. */
class ProvidersControllerTest {

    private static final String SESSIONS_CONTROLLER =
            "spectro-server/src/main/java/dev/spectroscope/server/session/SessionsController.java";

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
    void localChecksOnlyTheLocalKind() {
        List<String> dialled = new CopyOnWriteArrayList<>();
        ProviderRegistry registry = new ProviderRegistry((p, c) -> {
            dialled.add(p);
            return ListResult.ok(List.of(), "http://127.0.0.1:1");
        }, System::currentTimeMillis);
        new ProvidersController(registry).check("local", local());
        assertTrue(dialled.stream().allMatch(SpectroConfig.keylessLocalServers()::contains), dialled.toString());
        assertTrue(dialled.contains("ollama"), "the positive half: a local provider was in fact checked");
    }

    /**
     * The key save routes must drop the stored answer, because the registry's
     * signature sees a key appear or vanish but not one key replaced by
     * another. A source pin, since driving the real routes would write the
     * operator's {@code ~/.spectro/.env}. Both routes call it once each.
     */
    @Test
    void bothKeySaveRoutesInvalidateTheRegistry() throws IOException {
        String source = Files.readString(repoRoot().resolve(SESSIONS_CONTROLLER), StandardCharsets.UTF_8);
        String call = "ProviderRegistry.shared().invalidate(";
        int count = 0;
        for (int at = source.indexOf(call); at >= 0; at = source.indexOf(call, at + call.length())) {
            count++;
        }
        assertEquals(2, count, "/api/onboarding/key and /api/settings/env each invalidate once; found " + count);
    }

    private static Path repoRoot() {
        Path here = Path.of("").toAbsolutePath();
        while (here != null && !Files.exists(here.resolve("settings.gradle.kts"))) {
            here = here.getParent();
        }
        return here == null ? Path.of("").toAbsolutePath() : here;
    }
}
