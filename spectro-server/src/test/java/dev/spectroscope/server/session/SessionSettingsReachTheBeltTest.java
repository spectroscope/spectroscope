package dev.spectroscope.server.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.ToolRegistry;
import dev.spectroscope.core.web.BrowsePageTool;
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
import static org.junit.jupiter.api.Assumptions.assumeTrue;

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

    /**
     * What {@code generate_image} answers right now.
     *
     * <p>No image is ever generated here: with no key for the resolved backend
     * the tool refuses by NAMING that backend's own variable, which is how it
     * says which backend it picked without anyone paying for a picture. The
     * assumption above the calling tests keeps it that way on a machine whose
     * environment does carry a key.</p>
     *
     * @param belt the session's belt
     * @param cwd  the workspace the call runs in
     * @return the tool's answer, verbatim
     */
    private static String generate(ToolRegistry belt, Path cwd) {
        Tool tool = belt.get("generate_image").orElseThrow(
                () -> new AssertionError("the belt carries no generate_image at all"));
        return tool.execute(JSON.createObjectNode().put("prompt", "a spectrum"),
                new Tool.ToolContext(cwd, new CancelSignal()));
    }

    /** Saves one settings key into the workspace's own settings file, exactly
     *  where the settings page's project-scope PUT writes it. */
    private static void saveInWorkspace(Path workspace, String json) throws IOException {
        Path file = workspace.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
    }

    /**
     * Saves into {@code ~/.spectro/settings.json} — the USER scope, which is
     * where {@code allowLocalhost} has to live: it is process-global and
     * {@code SpectroConfig} refuses it in a workspace scope on purpose, because
     * the workspace is the folder the agent itself writes into (card 199, F4).
     * The Gradle test task points {@code user.home} into the build directory, so
     * this never touches the real home; the previous content is handed back for
     * {@link #restoreUserSettings} because this file is shared across the module's
     * tests and leaving a fence opt-in behind would be a gift to the next one.
     *
     * @param json the whole settings file to write
     * @return what was there before, or null when there was no file
     */
    private static String saveForUser(String json) throws IOException {
        Path file = dev.spectroscope.core.config.SettingsWriter.userSettingsFile();
        String previous = Files.exists(file) ? Files.readString(file) : null;
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
        return previous;
    }

    /** Puts the user settings file back the way it was found.
     *  @param previous the content {@link #saveForUser} handed back */
    private static void restoreUserSettings(String previous) throws IOException {
        Path file = dev.spectroscope.core.config.SettingsWriter.userSettingsFile();
        if (previous == null) {
            Files.deleteIfExists(file);
        } else {
            Files.writeString(file, previous);
        }
    }

    /** A connection whose workspace is settled, as buildAgentOnce settles it
     *  before it registers a single tool.
     *  @param socketId a name for the fake socket
     *  @param workspace the folder this session works in
     *  @return the connection, ready to build a belt */
    private static SessionConnection sessionIn(String socketId, Path workspace) {
        return sessionOn(new FakeSocket(socketId, "ws://localhost/ws"), workspace);
    }

    /** The same session, over a socket the caller keeps — for the tests that
     *  assert what the OPERATOR was told, not only what the belt did.
     *  @param socket the recording socket the caller holds on to
     *  @param workspace the folder this session works in
     *  @return the connection, ready to build a belt */
    private static SessionConnection sessionOn(FakeSocket socket, Path workspace) {
        SessionConnection connection = new SessionConnection(socket, JSON, configuredAt(workspace), null);
        connection.start();
        connection.onSetWorkspace("set", workspace.toString());
        connection.adoptSessionConfig();   // the session moment, as buildAgentOnce takes it
        return connection;
    }

    /** How often {@code needle} occurs in {@code haystack} — the frames a socket
     *  received are one long string, and "told once" is a count.
     *  @param haystack every frame this socket was sent, joined
     *  @param needle   the phrase whose repetitions are being counted
     *  @return the number of occurrences */
    private static int occurrences(String haystack, String needle) {
        int count = 0;
        for (int at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
            count++;
        }
        return count;
    }

    @Test
    void aSearxngAddressSavedMidSessionReachesTheNextSearch(@TempDir Path workspace)
            throws IOException {
        Instance before = startInstance("the instance from before");
        Instance saved = startInstance("the instance saved mid-session");
        // The USER scope, because that is where the settings page's search block
        // writes (onSave={saveUser}) — and, since card 222's review, the only
        // scope that may hold this key at all: an address inside the agent's own
        // workspace would let a run redirect its own later searches.
        String previous = saveForUser("{\"searxngUrl\": \"" + before.address() + "\"}");
        try {
            SessionConnection connection = sessionIn("ws-222", workspace);
            ToolRegistry belt = new ToolRegistry();
            connection.registerSettingsTools(belt);

            assertThat(search(belt, workspace))
                    .as("test premise: the belt starts on the address the session opened with")
                    .contains(before.name());

            // The operator saves a different address, mid-session, with the belt
            // already built — the moment card 222 is about.
            saveForUser("{\"searxngUrl\": \"" + saved.address() + "\"}");

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
        } finally {
            restoreUserSettings(previous);
        }
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
        String previous = saveForUser("{}");
        try {
            SessionConnection connection = sessionIn("ws-222-first", workspace);
            ToolRegistry belt = new ToolRegistry();
            connection.registerSettingsTools(belt);
            Tool tool = belt.get("web_search").orElseThrow();

            assertThat(tool.description())
                    .as("test premise: nothing is saved, so the belt is on the scrape tier")
                    .containsIgnoringCase(WebSearchTiers.DUCKDUCKGO)
                    .doesNotContain(saved.address());

            saveForUser("{\"searxngUrl\": \"" + saved.address() + "\"}");

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
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theNetFenceOptInSavedMidSessionReachesTheNextFetch(@TempDir Path workspace)
            throws IOException {
        // The same defect one tool over, and the reason this card is not a
        // web_search card: the fence had a per-call supplier already, and the
        // supplier read a snapshot nobody updated. Five tools share this fence.
        Instance page = startInstance("a page on loopback");
        String previous = saveForUser("{\"allowLocalhost\": false}");
        try {
            SessionConnection connection = sessionIn("ws-222-fence", workspace);
            ToolRegistry belt = new ToolRegistry();
            connection.registerSettingsTools(belt);
            Tool fetch = belt.get("web_fetch").orElseThrow();
            var call = JSON.createObjectNode().put("url", page.address() + "/");

            assertThat(fetch.execute(call, new Tool.ToolContext(workspace, new CancelSignal())))
                    .as("test premise: with the opt-in off, loopback is refused")
                    .startsWith("ERROR: web_fetch");
            assertThat(page.served()).hasValue(0);

            saveForUser("{\"allowLocalhost\": true}");

            assertThat(fetch.execute(call, new Tool.ToolContext(workspace, new CancelSignal())))
                    .as("the opt-in reaches the fetch that follows it")
                    .doesNotStartWith("ERROR:");
            assertThat(page.served())
                    .as("the page was actually reached, not merely permitted on paper")
                    .hasValue(1);
        } finally {
            restoreUserSettings(previous);
        }
    }

    @Test
    void theSnapshotStaysPutSoTheLiveReadingIsTheOneThatMoved(@TempDir Path workspace)
            throws IOException {
        // The mechanism under all of the above, asserted on its own. It is worth
        // its own test because the shape that failed the owner LOOKED right: the
        // neighbours had per-call suppliers, and the value those suppliers read
        // was written at connect, at the session moment and by a provider switch
        // — and by no settings write, ever. Per-call over something frozen.
        SessionConnection connection = sessionIn("ws-222-mechanism", workspace);
        assertThat(connection.liveConfig().imageModel())
                .as("test premise: nothing is configured yet")
                .isNull();

        saveInWorkspace(workspace, "{\"imageModel\": \"saved-mid-session\"}");

        assertThat(connection.liveConfig().imageModel())
                .as("the live reading sees the file that was just written")
                .isEqualTo("saved-mid-session");
    }

    // ---- review finding F1: the note on the page covered a field that was not live ----

    /** The two image tests read WHICH backend was resolved off the refusal that
     *  backend gives when its key is missing. On a machine whose environment
     *  carries one of those keys the tool would go and generate a picture
     *  instead, so there the claim is not assertable this cheaply and the test
     *  stands down rather than spending someone's money. */
    private static void assumeNoImageKeys() {
        assumeTrue(System.getenv("GEMINI_API_KEY") == null && System.getenv("OPENAI_API_KEY") == null,
                "an image key is set in this environment — generate_image would really generate");
    }

    @Test
    void theImageBackendSavedMidSessionReachesTheOpenSession(@TempDir Path workspace)
            throws IOException {
        assumeNoImageKeys();
        // The reviewer's probe, adopted. The first version of this card put
        // "applies immediately" under the image block and wrote in the code that
        // "both dropdowns above reach an open session" — while the backend half
        // read imageProviderName, an in-memory reference the session moment and
        // the websocket write and NO settings write ever touches. The model half
        // was live, the backend half was the card's own defect one field over.
        SessionConnection connection = sessionIn("ws-222-image", workspace);
        ToolRegistry belt = new ToolRegistry();
        connection.registerSettingsTools(belt);

        assertThat(generate(belt, workspace))
                .as("test premise: the session opens on the default backend, and with no key"
                        + " the error names that backend's variable")
                .contains("GEMINI_API_KEY");

        // Exactly what the settings page's image-backend dropdown does: a PUT
        // that lands in a settings file, with the belt already built.
        saveInWorkspace(workspace, "{\"imageProvider\": \"openai\", \"imageModel\": \"gpt-image-1\"}");

        assertThat(connection.liveConfig().imageProvider())
                .as("test premise: the file moved and the live reading sees it")
                .isEqualTo("openai");
        assertThat(generate(belt, workspace))
                .as("the backend saved mid-session is the one the next generation uses")
                .contains("OPENAI_API_KEY");
    }

    @Test
    void theLiveDropdownStillOutranksAFileSavedUnderIt(@TempDir Path workspace)
            throws IOException {
        assumeNoImageKeys();
        // The other direction of the same fix, and the reason it is not a
        // one-line change: the image backend has a LIVE control of its own (the
        // websocket set_image_provider the composer sends). Reading the file per
        // call must not undo an operator's live choice — the session moment
        // already obeys imageProviderTouched, and the belt now obeys it too.
        SessionConnection connection = sessionIn("ws-222-image-touched", workspace);
        ToolRegistry belt = new ToolRegistry();
        connection.registerSettingsTools(belt);

        connection.onSetImageProvider("openai");
        saveInWorkspace(workspace, "{\"imageProvider\": \"gemini\"}");

        assertThat(connection.liveConfig().imageProvider())
                .as("test premise: the FILE says gemini")
                .isEqualTo("gemini");
        assertThat(generate(belt, workspace))
                .as("the operator's live choice outranks a file saved under it")
                .contains("OPENAI_API_KEY");
    }

    // ---- review finding F4: nothing pinned that a real session HAS this belt ----

    @Test
    void aSessionThatBuiltItsAgentCarriesTheWholeSettingsBelt(@TempDir Path workspace)
            throws IOException {
        // The reviewer's own bite: deleting registerSettingsTools(registry) from
        // buildAgentOnce takes web_search, web_fetch, browse_page,
        // generate_image, seven browser tools and five launch tools out of every
        // real session — and the full gate stayed green, 2286 tests. The four
        // tests above build their belt by hand, so none of them can see the call
        // site. This one drives the real build.
        //
        // The provider goes in the USER SETTINGS and not in the flags, and that
        // is not a detail: the session moment re-resolves with
        // Overrides.none(), so a flags-layer provider is dropped there unless a
        // live switch put it back. Passed as a flag, this test built an
        // anthropic provider and died on the missing key — but only inside the
        // full suite, where the shared test-home settings file happened to say
        // something else. An order-dependent test is worse than no test.
        String previous = saveForUser("{\"provider\": \"ollama\", \"model\": \"qwen3:latest\"}");
        try {
            SessionConnection connection = sessionOn(
                    new FakeSocket("ws-222-callsite", "ws://localhost/ws"), workspace);
            connection.buildAgentOnce();

            assertThat(connection.belt())
                    .as("a session that has run its first prompt holds the belt it built")
                    .isNotNull();
            assertThat(connection.belt().specs().stream().map(spec -> spec.name()))
                    .as("every family registerSettingsTools puts on the belt is on the session's belt")
                    .contains("web_search", "web_fetch", "browse_page", "generate_image",
                            "browser_navigate", "launch_start");
        } finally {
            restoreUserSettings(previous);
        }
    }

    // ---- review finding F2 + F3: the sandbox must not hold the switch, and a
    // ---- refusal the operator never hears is the card's own defect again

    @Test
    void aBinaryTheAgentPlantsInItsOwnWorkspaceNeverReachesBrowsePage(@TempDir Path workspace)
            throws IOException {
        // Card 199's rule, applied to the key card 222 made live: "a fence whose
        // switch lives inside the sandbox it guards can be flipped by the thing
        // it guards". chromeBinary NAMES AN EXECUTABLE that browse_page launches,
        // and the workspace is the folder the agent's own write_file writes into.
        // Before this card that reached the next session; per-call reading made
        // it reach the next tool call.
        FakeSocket socket = new FakeSocket("ws-222-planted", "ws://localhost/ws");
        SessionConnection connection = sessionOn(socket, workspace);

        Path planted = workspace.resolve("not-a-browser.sh");
        Files.writeString(planted, "#!/bin/sh\necho pwned\n");
        assertThat(planted.toFile().setExecutable(true)).isTrue();
        Path local = workspace.resolve(SpectroConfig.WS_LOCAL_SETTINGS);
        Files.createDirectories(local.getParent());
        Files.writeString(local, "{\"chromeBinary\": \"" + planted.toAbsolutePath() + "\"}");

        assertThat(connection.liveConfig().chromeEnv().get("SPECTRO_CHROME"))
                .as("the workspace's own file must not name the browser binary")
                .isNull();
        assertThat(BrowsePageTool.findChrome(connection.liveConfig().chromeEnv()).orElse(null))
                .as("and browse_page must not be pointed at it")
                .isNotEqualTo(planted.toAbsolutePath());
    }

    @Test
    void aRefusedWorkspaceFileIsSaidOnceAndTheBeltKeepsAnswering(@TempDir Path workspace)
            throws IOException {
        // F3. liveConfig()'s own javadoc claimed the reader "is told once per
        // call site by the same error frame the session moment uses", and the
        // body was catch (RuntimeException unreadable) { return last; } — no
        // frame, nothing. A comment stating an intent the code cancels is
        // criterion 4's defect, reintroduced by the change ordered to remove two
        // of them. It matters more now than it read: a refused workspace scope
        // silently drops EVERY key in that file for the rest of the session.
        //
        // Told once, not once per call: the belt reads the settings on every
        // tool call, so "report on failure" without a memory is a frame storm.
        FakeSocket socket = new FakeSocket("ws-222-refused", "ws://localhost/ws");
        SessionConnection connection = sessionOn(socket, workspace);
        saveInWorkspace(workspace, "{\"imageModel\": \"before-the-break\"}");
        assertThat(connection.liveConfig().imageModel())
                .as("test premise: the workspace scope is being read")
                .isEqualTo("before-the-break");

        // The agent writes a key its own scope may not hold. The whole file goes.
        saveInWorkspace(workspace, "{\"imageModel\": \"after\", \"allowLocalhost\": true}");

        assertThat(connection.liveConfig().imageModel())
                .as("the session's own config answers — a broken file is not fatal, and the"
                        + " fallback is the session moment rather than the last live reading:"
                        + " a refused file must not leave the session standing on a value"
                        + " that came from the same hand")
                .isNull();
        connection.liveConfig();
        connection.liveConfig();

        assertThat(occurrences(socket.textJoined(), "allowLocalhost"))
                .as("the operator is told that a settings file was ignored — exactly once,"
                        + " however many tool calls read it")
                .isEqualTo(1);
    }
}
