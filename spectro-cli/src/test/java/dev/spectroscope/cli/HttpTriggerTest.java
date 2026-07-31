package dev.spectroscope.cli;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The HTTP trigger's security posture, end to end against the real bound
 * server: loopback bind by construction, bearer token on every request,
 * POST /trigger only, oversize bodies refused whole (413, never truncated),
 * and the busy answer (429) when the slot already holds a fire.
 */
@Timeout(value = 15, unit = TimeUnit.SECONDS)
class HttpTriggerTest {

    private static final String TOKEN = "aaaabbbbccccddddeeeeffff00001111";

    private HttpTrigger trigger;
    private final AtomicReference<Fire> seen = new AtomicReference<>();
    private volatile FireSlot.Disposition answer = FireSlot.Disposition.ACCEPTED;
    private final HttpClient client = HttpClient.newHttpClient();

    @BeforeEach
    void start() throws Exception {
        trigger = new HttpTrigger(0, TOKEN, line -> { });
        trigger.start(fire -> {
            seen.set(fire);
            return answer;
        });
    }

    @AfterEach
    void stop() {
        trigger.close();
    }

    private HttpResponse<String> post(String path, String body, String auth) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + trigger.port() + path))
                .POST(HttpRequest.BodyPublishers.ofString(body));
        if (auth != null) {
            request.header("Authorization", auth);
        }
        return client.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void theBindIsLoopbackByConstruction() {
        assertTrue(trigger.boundAddress().isLoopbackAddress(),
                "non-loopback is unbindable — the address is chosen by the code, not a flag");
        assertEquals("listen:127.0.0.1:" + trigger.port(), trigger.describe());
    }

    @Test
    void everyRequestNeedsTheBearerToken() throws Exception {
        assertEquals(401, post("/trigger", "payload", null).statusCode());
        assertEquals(401, post("/trigger", "payload", "Bearer wrong-token").statusCode());
        assertNull(seen.get(), "an unauthorized request never becomes a fire");
    }

    @Test
    void onlyPostTriggerIsRouted() throws Exception {
        assertEquals(404, post("/other", "x", "Bearer " + TOKEN).statusCode());
        HttpResponse<String> get = client.send(HttpRequest.newBuilder()
                        .uri(URI.create("http://127.0.0.1:" + trigger.port() + "/trigger"))
                        .header("Authorization", "Bearer " + TOKEN).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        assertEquals(405, get.statusCode());
        assertNull(seen.get());
    }

    @Test
    void anAcceptedPostBecomesAFireWithTheVerbatimPayload() throws Exception {
        HttpResponse<String> response = post("/trigger", "{\"job\":\"nightly\"}", "Bearer " + TOKEN);
        assertEquals(202, response.statusCode());
        assertTrue(response.body().contains("accepted"), response.body());

        Fire fire = seen.get();
        assertEquals("http", fire.kind());
        assertEquals("{\"job\":\"nightly\"}", fire.payload(), "verbatim, or refused — never edited");
        assertTrue(fire.remote().startsWith("127."), "the caller's loopback address is recorded");
    }

    @Test
    void anOversizeBodyIsRefusedWholeNeverTruncated() throws Exception {
        String tooBig = "x".repeat(64 * 1024 + 1);
        HttpResponse<String> response = post("/trigger", tooBig, "Bearer " + TOKEN);
        assertEquals(413, response.statusCode(),
                "a truncated payload silently changes meaning — refusal is the honest branch");
        assertNull(seen.get(), "the oversize payload never becomes a fire");

        String exactlyAtTheCap = "y".repeat(64 * 1024);
        assertEquals(202, post("/trigger", exactlyAtTheCap, "Bearer " + TOKEN).statusCode());
        assertEquals(exactlyAtTheCap, seen.get().payload());
    }

    @Test
    void aBusySlotAnswers429AndTheCallerKeepsThePayload() throws Exception {
        answer = FireSlot.Disposition.REFUSED;
        HttpResponse<String> response = post("/trigger", "do not lose me", "Bearer " + TOKEN);
        assertEquals(429, response.statusCode());
        assertTrue(response.body().contains("busy"), response.body());
    }
}
