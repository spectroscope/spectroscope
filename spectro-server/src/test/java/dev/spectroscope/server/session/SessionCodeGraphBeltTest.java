package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.provider.LlmProvider.ToolSpec;
import dev.spectroscope.core.subagents.RoleCatalog;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 547: the browser session registers {@code code_graph} on the main
 * agent and in the belt its children inherit, and the System context view
 * lists it for the main agent and for an explore child.
 */
@Timeout(value = 120, unit = TimeUnit.SECONDS, threadMode = Timeout.ThreadMode.SEPARATE_THREAD)
class SessionCodeGraphBeltTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private HttpServer backend;

    @AfterEach
    void stop() {
        if (backend != null) {
            backend.stop(0);
        }
    }

    private String startBackend() throws IOException {
        backend = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        backend.createContext("/api/chat", exchange -> {
            exchange.getRequestBody().readAllBytes();
            byte[] answer = """
                    {"message":{"content":"done"},"done":false}
                    {"message":{"content":""},"done":true,"prompt_eval_count":6,"eval_count":3}
                    """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/x-ndjson");
            exchange.sendResponseHeaders(200, answer.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(answer);
            }
        });
        backend.start();
        return "http://127.0.0.1:" + backend.getAddress().getPort();
    }

    @Test
    void theMainAgentAndTheChildBeltCarryCodeGraph(@TempDir Path workspace) throws Exception {
        String url = startBackend();
        Files.createDirectories(workspace.resolve(".spectro"));
        Files.writeString(workspace.resolve(".spectro/settings.json"), """
                { "provider": "ollama", "model": "qwen3", "baseUrl": "%s" }
                """.formatted(url));
        SpectroConfig config = SpectroConfig.load(new SpectroConfig.Overrides(
                "ollama", "qwen3", url, null, null, workspace.toString()));
        SessionConnection connection = new SessionConnection(
                new FakeSocket("ws-547", "ws://localhost/ws"), JSON, config, null);
        connection.start();
        try {
            connection.onUserMessage("hello", null);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
            while (System.nanoTime() < deadline
                    && (connection.belt() == null || connection.childBelt().isEmpty())) {
                Thread.sleep(25);
            }
            List<String> parent = connection.belt().specs().stream().map(ToolSpec::name).toList();
            assertThat(parent).as("the main agent holds code_graph").contains("code_graph");
            assertThat(connection.childBelt().stream().map(Tool::name).toList())
                    .as("the children inherit code_graph").contains("code_graph");
            assertThat(connection.belt().get("code_graph").orElseThrow().needsPermission()).isFalse();
        } finally {
            connection.onClose();
        }
    }

    @Test
    void theSystemContextViewListsCodeGraphForMainAndExplore(@TempDir Path cwd) {
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none(), cwd);
        ContextInfo context = ContextDescriber.describe(config, cwd);
        assertThat(context.tools().stream().map(ContextInfo.ToolInfo::name).toList()).contains("code_graph");
        RoleCatalog.RoleProfile explore = context.subagentProfiles().stream()
                .filter(profile -> profile.type().equals("explore")).findFirst().orElseThrow();
        assertThat(explore.tools()).contains("code_graph");
        assertThat(context.systemPrompt())
                .as("a folder without a graph is not offered the tool, so the prompt does not name it")
                .doesNotContain(RoleCatalog.CODE_GRAPH_GUIDANCE);
    }
}
