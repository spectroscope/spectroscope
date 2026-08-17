package dev.spectroscope.core;

import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.OpenAiCompatProvider;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.core.tools.ToolRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 252, end to end and read off the WIRE: the owner's wedge, reproduced
 * against a scripted OpenAI-compatible server that refuses images the way
 * deepseek did, and then healed.
 *
 * <p>Prompt one goes out with the picture and comes back HTTP 400. Prompt two
 * is the whole point of the card: on the old build it carried the same image
 * again — the history keeps it — and failed identically, and so did every
 * prompt after it. Here the assertion is on the POSTED REQUEST BODY, not on an
 * event: an {@code image_url} part in body two would mean the fence exists only
 * in the transcript.</p>
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class VisionWedgeEndToEndTest {

    private static final String DEEPSEEK_REFUSAL =
            "{\"error\":{\"message\":\"The provided messages contain images, "
            + "but deepseek-v4-flash does not support image inputs\",\"type\":\"invalid_request_error\"}}";

    private static final String ONE_ANSWER = """
            data: {"choices":[{"delta":{"content":"three files"}}]}

            data: {"choices":[{"delta":{},"finish_reason":"stop"}]}

            data: [DONE]

            """;

    private HttpServer server;
    private String baseUrl;
    private final List<String> postedBodies = new CopyOnWriteArrayList<>();
    private volatile boolean refuseImages = true;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            postedBodies.add(body);
            // The server behaves like the real one: it refuses whatever carries an
            // image, and answers anything that does not. Nothing here knows about
            // the harness's fence — the second prompt passes only because the
            // request really changed.
            if (refuseImages && body.contains("image_url")) {
                byte[] error = DEEPSEEK_REFUSAL.getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(400, error.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(error);
                }
                return;
            }
            byte[] sse = ONE_ANSWER.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, sse.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(sse);
            }
        });
        server.start();
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    @Test
    void theSecondPromptRunsAndItsRequestBodyCarriesNoImage() {
        String sessionId = "card252-e2e-" + UUID.randomUUID().toString().substring(0, 8);
        SessionStore.StoredBlob blob = SessionStore.saveBlob(
                sessionId, new byte[] {(byte) 0x89, 'P', 'N', 'G'}, "image/png");
        RunEvent.Attachment screenshot =
                new RunEvent.Attachment("image", "image/png", blob.blobPath(), blob.sha256());

        Agent agent = new Agent(AgentOptions.builder()
                .provider(new OpenAiCompatProvider(
                        new OpenAiCompatProvider.Options(baseUrl, "deepseek-v4-flash", null)))
                .systemPrompt("test")
                .registry(new ToolRegistry())
                .cwd(Path.of("."))
                .agentId("main")
                .onPermission(request -> true)
                .build());

        List<RunEvent> first = collect(agent, "What is on this screenshot?", List.of(screenshot));
        assertTrue(first.stream().anyMatch(RunEvent.ErrorEvent.class::isInstance),
                "premise: the server refuses this request, exactly like deepseek did");
        assertTrue(postedBodies.getFirst().contains("image_url"),
                "premise: the first prompt really sent the picture");
        RunEvent.ErrorEvent refusal = (RunEvent.ErrorEvent) first.stream()
                .filter(RunEvent.ErrorEvent.class::isInstance).findFirst().orElseThrow();
        assertTrue(refusal.message().startsWith("Model without vision"),
                "the operator gets the sharpened reason, got: " + refusal.message());

        // The prompt that used to fail forever. Same agent, same history — the
        // image is still in it, and still in the session record.
        List<RunEvent> second = collect(agent, "forget the picture — list the files", null);

        assertEquals(2, postedBodies.size(), "the second prompt reached the server");
        String secondBody = postedBodies.get(1);
        assertFalse(secondBody.contains("image_url"),
                "the wire is the proof: no image part travelled the second time");
        assertFalse(secondBody.contains(blob.sha256()), "and no bytes of it either");
        assertTrue(secondBody.contains("this model cannot process images"),
                "what stands in its place says so, in the model's own input");
        assertFalse(second.stream().anyMatch(RunEvent.ErrorEvent.class::isInstance),
                "the wedge is gone: the second prompt answers");
        assertEquals("end_turn",
                ((RunEvent.RunEnd) second.getLast()).stopReason());
        assertTrue(second.stream().anyMatch(RunEvent.ImagesWithheld.class::isInstance),
                "and the transcript carries the one honest line");
    }

    private static List<RunEvent> collect(Agent agent, String prompt,
                                          List<RunEvent.Attachment> attachments) {
        List<RunEvent> events = new ArrayList<>();
        try (EventStream stream = agent.run(prompt, new RunOptions(new CancelSignal(), attachments))) {
            stream.forEach(events::add);
        }
        return events;
    }
}
