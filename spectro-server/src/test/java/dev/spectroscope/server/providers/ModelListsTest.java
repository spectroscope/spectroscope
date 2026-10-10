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
