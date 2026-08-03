package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Pins the split cache policy from card 130. The entry document and the
 * content-hashed assets want opposite headers, and before this test they
 * shared none at all: with only {@code Last-Modified} a client falls back to
 * heuristic freshness and may serve a cached {@code index.html} without asking
 * the server. A stale shell then requests hashed assets a new jar no longer
 * carries, and the answer is a 404 and a blank window — measured 2026-07-30
 * against an Electron shell whose HTTP cache had outlived an upgrade.
 *
 * <p>The policy: {@code index.html} and every non-hashed static answer
 * {@code Cache-Control: no-cache} (revalidate on every load — cheap, a 304 is
 * a header exchange), while {@code /assets/**} — names that change with their
 * content — answer a year-long immutable grant. The asset half rides a custom
 * {@code /assets/**} resource handler ({@link StaticCacheConfig}), and this
 * test is the precedence pin: if Boot's autoconfigured {@code /**} handler
 * ever won that path, the asset would answer {@code no-cache} instead.</p>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"server.address=127.0.0.1"})
class StaticCacheHeadersTest {

    @Autowired
    private TestRestTemplate rest;

    /** A real filename from the built bundle, read from the classpath the
     *  server serves — survives every {@code npm run gate} rehash. */
    private static String realBundleAsset() throws IOException {
        Path assets = Path.of(new ClassPathResource("static/assets").getURI());
        try (var files = Files.list(assets)) {
            return files.map(p -> p.getFileName().toString())
                    .filter(name -> name.startsWith("index-") && name.endsWith(".js"))
                    .findFirst()
                    .orElseThrow(() -> new IllegalStateException(
                            "no index-*.js in static/assets — was the web bundle built?"));
        }
    }

    @Test
    void indexHtmlMustRevalidateOnEveryLoad() {
        for (String path : new String[]{"/", "/index.html"}) {
            ResponseEntity<String> response = rest.getForEntity(path, String.class);
            assertEquals(HttpStatus.OK, response.getStatusCode(), path);
            String cacheControl = response.getHeaders().getCacheControl();
            assertNotNull(cacheControl, path + " carries no Cache-Control — heuristic freshness"
                    + " lets a client keep a shell whose assets no longer exist");
            assertTrue(cacheControl.contains("no-cache"),
                    path + " must revalidate always, got: " + cacheControl);
            assertFalse(cacheControl.contains("max-age"),
                    path + " must not be granted a freshness window, got: " + cacheControl);
        }
    }

    @Test
    void hashedAssetsAreImmutableForAYear() throws IOException {
        String asset = "/assets/" + realBundleAsset();
        ResponseEntity<String> response = rest.getForEntity(asset, String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), asset);
        String cacheControl = response.getHeaders().getCacheControl();
        assertNotNull(cacheControl, asset + " carries no Cache-Control");
        assertTrue(cacheControl.contains("max-age=31536000"),
                asset + " is content-addressed and never needs revalidating, got: " + cacheControl);
        assertTrue(cacheControl.contains("immutable"),
                asset + " should spare even the revalidation request, got: " + cacheControl);
        // The precedence pin: the custom /assets/** handler must win over the
        // autoconfigured /** one, whose policy is no-cache.
        assertFalse(cacheControl.contains("no-cache"),
                asset + " fell through to the /** handler, got: " + cacheControl);
    }

    @Test
    void nonHashedStaticsRevalidateLikeTheIndex() {
        // brand/ and demo/ files keep stable names across builds, so they get
        // the revalidate-always policy, not the immutable one.
        ResponseEntity<byte[]> response = rest.getForEntity("/brand/favicon.svg", byte[].class);
        assertEquals(HttpStatus.OK, response.getStatusCode(), "/brand/favicon.svg");
        String cacheControl = response.getHeaders().getCacheControl();
        assertNotNull(cacheControl, "/brand/favicon.svg carries no Cache-Control");
        assertTrue(cacheControl.contains("no-cache"),
                "non-hashed statics must revalidate, got: " + cacheControl);
    }
}
