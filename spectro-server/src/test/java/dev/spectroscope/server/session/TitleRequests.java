package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Card 445: since the first run of a new session also asks its model for a
 * title, in the background, a scripted Ollama that numbers its requests sees
 * one request that is not the run's. The doubles that count ask this class
 * first and answer that request apart, so their numbering still counts the
 * run's calls and nothing else.
 */
final class TitleRequests {

    private static final ObjectMapper JSON = new ObjectMapper();

    private TitleRequests() {
    }

    /**
     * @param body the request body a scripted {@code /api/chat} received
     * @return true when it is the title request: its system message is
     *         {@link SessionTitles#INSTRUCTION}
     */
    static boolean isTitleRequest(String body) {
        try {
            JsonNode first = JSON.readTree(body).path("messages").path(0);
            return "system".equals(first.path("role").asText())
                    && SessionTitles.INSTRUCTION.equals(first.path("content").asText());
        } catch (IOException notJson) {
            return false;
        }
    }

    /**
     * Answers the title request with a short title, as Ollama streams one.
     *
     * @param exchange the title request
     */
    static void answer(HttpExchange exchange) throws IOException {
        byte[] ndjson = ("{\"message\":{\"role\":\"assistant\",\"content\":\"Scripted session title\"},"
                + "\"done\":false}\n"
                + "{\"message\":{\"role\":\"assistant\",\"content\":\"\"},\"done\":true,"
                + "\"done_reason\":\"stop\",\"prompt_eval_count\":9,\"eval_count\":3}\n")
                .getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
        exchange.sendResponseHeaders(200, ndjson.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(ndjson);
        }
    }
}
