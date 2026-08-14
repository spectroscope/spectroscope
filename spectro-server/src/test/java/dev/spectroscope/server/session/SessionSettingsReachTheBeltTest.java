package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.web.WebSearchTiers;
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
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Card 222: a setting saved while a session is open has to reach that session's
 * next tool call.
 *
 * <p>The owner hit this on 2026-08-14 in his own window. SearXNG was up and
 * answering JSON, {@code /api/config} said the tier was {@code searxng}, the
 * settings page drew exactly that — and the next {@code web_search} in the open
 * session went to DuckDuckGo and came back with a bot-check page. The cause was
 * a lifetime, not a rule: {@code buildAgentOnce} opens with
 * {@code if (agent != null) return;}, so the whole belt — including the search
 * tier — was resolved once, at the first prompt, and never again.</p>
 *
 * <p>The assertion is deliberately made on the tier the tool <b>used</b>, not on
 * what the configuration returns. Asking the config would have passed on the
 * night this broke: the config was right and the belt was old, and that gap is
 * the entire defect. So a mock instance answers here and the test asks whether
 * it was dialled.</p>
 */
@Timeout(value = 30, unit = TimeUnit.SECONDS)
class SessionSettingsReachTheBeltTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private final List<HttpServer> instances = new ArrayList<>();

    @AfterEach
    void stopInstances() {
        instances.forEach(server -> server.stop(0));
    }

    /**
     * A mock SearXNG on loopback that answers one hit and counts what it served.
     *
     * <p>Two of these stand in for the operator's before and after, and nothing
     * in this file ever leaves the loopback interface. The first red run of this
     * test did leave it: with nothing configured, the belt's tier was the
     * DuckDuckGo scrape, and the test executed it for real and was answered with
     * a bot-check page — the owner's own failure sentence, reproduced by a unit
     * test against the live internet. Right diagnosis, wrong place to get it.</p>
     *
     * @param name what this instance calls itself in the hits it returns
     * @return the address to save in settings
     */
    private Instance startInstance(String name) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicInteger served = new AtomicInteger();
        server.createContext("/", exchange -> {
            served.incrementAndGet();
            byte[] body = ("""
                    {"query":"card 222","number_of_results":1,
                     "results":[{"url":"https://example.invalid/222",
                                 "title":"answered by %s",
                                 "content":"served by the mock searxng"}]}
                    """.formatted(name)).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        instances.add(server);
        return new Instance(name, "http://127.0.0.1:" + server.getAddress().getPort(), served);
    }

    /** One mock instance: its name, its address, and how often it was dialled.
     *  @param name    the name it puts in its hits
     *  @param address the base URL an operator would save in settings
     *  @param served  how many searches it has answered */
    private record Instance(String name, String address, AtomicInteger served) {
    }

    /** A config whose workspace is exactly {@code dir} — the flag layer, as the
     *  connect-time snapshot a real session starts from. */
    private static SpectroConfig configuredAt(Path dir) {
        return SpectroConfig.load(
                new SpectroConfig.Overrides(null, null, null, null, null, dir.toString()));
    }

    /** What {@code web_search} answers right now, header and all. */
    private static String search(ToolRegistry belt, Path cwd) {
        Tool tool = belt.get("web_search").orElseThrow(
                () -> new AssertionError("the belt carries no web_search at all"));
        return tool.execute(JSON.createObjectNode().put("query", "card 222"),
                new Tool.ToolContext(cwd, new CancelSignal()));
    }

    /** Saves one settings key into the workspace's own settings file, exactly
     *  where the settings page's project-scope PUT writes it. */
    private static void saveInWorkspace(Path workspace, String json) throws IOException {
        Path file = workspace.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
    }

    /** A connection whose workspace is settled, as buildAgentOnce settles it
     *  before it registers a single tool.
     *  @param socketId a name for the fake socket
     *  @param workspace the folder this session works in
     *  @return the connection, ready to build a belt */
    private static SessionConnection sessionIn(String socketId, Path workspace) {
        SessionConnection connection = new SessionConnection(
                new FakeSocket(socketId, "ws://localhost/ws"), JSON, configuredAt(workspace), null);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();   // the session moment, as buildAgentOnce takes it
        return connection;
    }

    @Test
    void aSearxngAddressSavedMidSessionReachesTheNextSearch(@TempDir Path workspace)
            throws IOException {
        Instance before = startInstance("the instance from before");
        Instance saved = startInstance("the instance saved mid-session");
        saveInWorkspace(workspace, "{\"searxngUrl\": \"" + before.address() + "\"}");

        SessionConnection connection = sessionIn("ws-222", workspace);
        ToolRegistry belt = new ToolRegistry();
        connection.registerSettingsTools(belt);

        assertThat(search(belt, workspace))
                .as("test premise: the belt starts on the address the session opened with")
                .contains(before.name());

        // The operator saves a different address, mid-session, with the belt
        // already built — the moment card 222 is about.
        saveInWorkspace(workspace, "{\"searxngUrl\": \"" + saved.address() + "\"}");

        assertThat(search(belt, workspace))
                .as("the next search goes to the machine the operator just named")
                .contains(WebSearchTiers.SEARXNG)
                .contains(saved.name());
        assertThat(saved.served())
                .as("the saved instance was dialled, not merely described")
                .hasValue(1);
        assertThat(before.served())
                .as("the old instance served the first search and not the second")
                .hasValue(1);
    }

    @Test
    void aFirstAddressSavedMidSessionMovesTheBeltOffTheScrapeTier(@TempDir Path workspace)
            throws IOException {
        // The owner's exact case: nothing configured, so the tier is the
        // DuckDuckGo scrape, and an address is saved while the session is open.
        // Asserted on the sentence the tool hands the MODEL rather than by
        // executing the scrape tier — a test that reaches the public internet to
        // prove a point is a flaky test and a rude one.
        Instance saved = startInstance("the first instance");

        SessionConnection connection = sessionIn("ws-222-first", workspace);
        ToolRegistry belt = new ToolRegistry();
        connection.registerSettingsTools(belt);
        Tool tool = belt.get("web_search").orElseThrow();

        assertThat(tool.description())
                .as("test premise: nothing is saved, so the belt is on the scrape tier")
                .containsIgnoringCase(WebSearchTiers.DUCKDUCKGO)
                .doesNotContain(saved.address());

        saveInWorkspace(workspace, "{\"searxngUrl\": \"" + saved.address() + "\"}");

        // The description is what the model is told the tool does, rebuilt for
        // every request. A description that names a tier the belt no longer
        // uses is the settings page's lie, one layer down.
        assertThat(tool.description())
                .as("the sentence the model reads names the instance now configured")
                .contains(WebSearchTiers.SEARXNG)
                .contains(saved.address());
        assertThat(search(belt, workspace))
                .as("and the search that follows it goes there")
                .contains(saved.name());
        assertThat(saved.served()).hasValue(1);
    }
}
