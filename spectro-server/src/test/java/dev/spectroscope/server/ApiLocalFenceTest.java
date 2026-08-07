package dev.spectroscope.server;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.server.starter.BundleController;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The read-side rebinding fence, card 74's remaining half. Card 161 fenced the
 * workspace and transcript reads one handler at a time; the endpoints left over
 * ({@code /api/sessions}, its events, {@code /api/config}, {@code /api/context},
 * {@code /api/models}, the capability lookup, the job states, the starter
 * bundles, the folder dialog and the transcriber) answered any Host, so a page
 * rebound from evil.example to 127.0.0.1 read session prompts and tool output,
 * fingerprinted the machine's providers, and could pop a native folder chooser
 * on the operator's screen.
 *
 * <p>Every case goes through the real request mapping with the real filter in
 * the chain, because the claim is about what a REQUEST does. A direct call to
 * the helper cannot state it, and neither can a controller test with no filter:
 * the fence does not live in the handler any more.</p>
 */
class ApiLocalFenceTest {

    private MockMvc mvc;

    /** A skills root that is not the operator's — card 182's install writes files. */
    @TempDir
    Path skillRoots;

    /** A session that really exists on disk — the Gradle test task points
     *  {@code user.home} into the build directory, so this never touches the
     *  operator's own store. */
    private String storedSession;

    @BeforeEach
    void theApiBehindItsFilter() {
        storedSession = "fence-" + UUID.randomUUID().toString().substring(0, 8);
        SessionStore store = new SessionStore(storedSession);
        store.append(new RunEvent.RunStart("r1", "main", null, "hi", null, null, 1L));

        mvc = MockMvcBuilders.standaloneSetup(
                        new SessionsController(),
                        new ModelCapabilityController(),
                        new BundleController(),
                        new TranscribeController(),          // no whisper model here: answers 503
                        new WorkspacePickController(() -> Optional.of("/tmp/picked")))
                .addFilters(new ApiLocalFence())
                .build();
    }

    @Test
    void aReboundHostReadsNoSessionList() throws Exception {
        mvc.perform(get("http://evil.example/api/sessions")).andExpect(status().isNotFound());
    }

    @Test
    void aReboundHostReadsNoSessionEvents() throws Exception {
        mvc.perform(get("http://evil.example/api/sessions/" + storedSession + "/events"))
                .andExpect(status().isNotFound());
    }

    @Test
    void aReboundHostCannotDeleteASession() throws Exception {
        // A malformed id separates the two refusals: the handler answers 400 for
        // it, the fence answers a blank 404 before the handler is ever reached.
        mvc.perform(delete("http://evil.example/api/sessions/not a session id"))
                .andExpect(status().isNotFound());
    }

    @Test
    void anEncodedPrefixIsStillTheApi() throws Exception {
        // The filter must read the path the MAPPING reads, not the raw target.
        // A browser preserves an escape it was given, so a rebound page can ask
        // for /%61pi/config; a fence matching the raw string sees no "/api/"
        // there, waves the request on, and the container — which dispatches on
        // the decoded path — hands it to the handler. Measured live against the
        // first cut of this filter: 200 with the full config body, and a DELETE
        // that took a session off disk.
        //
        // Driven through the filter directly rather than MockMvc: the standalone
        // setup never decodes the target, so it cannot stage the attack at all
        // and would pass whatever the filter did.
        MockFilterChain chain = new MockFilterChain();
        MockHttpServletResponse response = new MockHttpServletResponse();
        new ApiLocalFence().doFilter(rebound("/%61pi/config"), response, chain);

        assertEquals(404, response.getStatus());
        assertNull(chain.getRequest(), "the request must not reach the chain at all");
    }

    @Test
    void anEncodedPrefixFromLoopbackStillReachesItsHandler() throws Exception {
        // The fence decodes to DECIDE, never to rewrite: a loopback caller that
        // spells its path oddly is not an attacker and must travel on.
        MockFilterChain chain = new MockFilterChain();
        MockHttpServletResponse response = new MockHttpServletResponse();
        new ApiLocalFence().doFilter(loopback("/%61pi/config"), response, chain);

        assertNotNull(chain.getRequest(), "a loopback request must reach the chain");
    }

    /** A request from a page rebound to this machine: real loopback peer, foreign Host. */
    private static MockHttpServletRequest rebound(String uri) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", uri);
        request.setRequestURI(uri);
        request.setRemoteAddr("127.0.0.1");
        request.addHeader("Host", "evil.example");
        return request;
    }

    /** The honest local caller, same path spelling. */
    private static MockHttpServletRequest loopback(String uri) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", uri);
        request.setRequestURI(uri);
        request.setRemoteAddr("127.0.0.1");
        request.addHeader("Host", "127.0.0.1:8080");
        return request;
    }

    @Test
    void aReboundHostReadsNeitherConfigNorContext() throws Exception {
        mvc.perform(get("http://evil.example/api/config")).andExpect(status().isNotFound());
        mvc.perform(get("http://evil.example/api/context")).andExpect(status().isNotFound());
    }

    @Test
    void aReboundHostReadsNoModelListAndNoCapability() throws Exception {
        mvc.perform(get("http://evil.example/api/models").param("provider", "anthropic"))
                .andExpect(status().isNotFound());
        mvc.perform(get("http://evil.example/api/models/capabilities")
                        .param("provider", "anthropic").param("model", "claude-sonnet-5"))
                .andExpect(status().isNotFound());
    }

    @Test
    void aReboundHostReadsNoJobStates() throws Exception {
        mvc.perform(get("http://evil.example/api/jobs/state")).andExpect(status().isNotFound());
    }

    @Test
    void aReboundHostReadsNoStarterBundles() throws Exception {
        mvc.perform(get("http://evil.example/api/bundles")).andExpect(status().isNotFound());
        mvc.perform(get("http://evil.example/api/bundles/five-lines"))
                .andExpect(status().isNotFound());
    }

    @Test
    void aReboundHostCannotOpenTheFolderDialogOnTheOperatorsScreen() throws Exception {
        mvc.perform(post("http://evil.example/api/pick-workspace"))
                .andExpect(status().isNotFound());
    }

    @Test
    void aReboundHostCannotSpendTheTranscriber() throws Exception {
        mvc.perform(post("http://evil.example/api/transcribe").content(new byte[] {1, 2, 3}))
                .andExpect(status().isNotFound());
    }

    @Test
    void aLoopbackCallerStillGetsEveryOneOfThem() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/sessions")).andExpect(status().isOk());
        mvc.perform(get("http://localhost/api/sessions/" + storedSession + "/events"))
                .andExpect(status().isOk());
        mvc.perform(get("http://127.0.0.1/api/config")).andExpect(status().isOk());
        mvc.perform(get("http://localhost/api/context")).andExpect(status().isOk());
        mvc.perform(get("http://127.0.0.1/api/models").param("provider", "nothing-live"))
                .andExpect(status().isOk());
        mvc.perform(get("http://localhost/api/models/capabilities")
                        .param("provider", "nothing-live").param("model", "x"))
                .andExpect(status().isOk());
        mvc.perform(get("http://127.0.0.1/api/jobs/state")).andExpect(status().isOk());
        mvc.perform(get("http://localhost/api/bundles")).andExpect(status().isOk());
        mvc.perform(get("http://127.0.0.1/api/bundles/five-lines")).andExpect(status().isOk());
        mvc.perform(post("http://localhost/api/pick-workspace")).andExpect(status().isOk());
        // Reaching the handler is the point; without a whisper model it answers
        // its honest 503, which a fence refusal would have hidden behind a 404.
        mvc.perform(post("http://127.0.0.1/api/transcribe").content(new byte[] {1, 2, 3}))
                .andExpect(status().isServiceUnavailable());
        // And the handler, not the fence, is what refuses a malformed delete.
        mvc.perform(delete("http://localhost/api/sessions/not a session id"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void aNonLoopbackPeerIsRefusedEvenWhenItClaimsALocalhostHost() throws Exception {
        mvc.perform(get("http://localhost/api/sessions")
                        .with(request -> {
                            request.setRemoteAddr("203.0.113.7"); // TEST-NET, not loopback
                            return request;
                        }))
                .andExpect(status().isNotFound());
    }

    @Test
    void theHealthProbeStaysOpenOnPurpose() throws Exception {
        // The desktop shell polls it before the UI exists, and being reachable
        // IS the whole answer — there is nothing here to read.
        mvc.perform(get("http://evil.example/api/health")).andExpect(status().isOk());
    }

    @Test
    void anEncodedPrefixCannotReachInstall() throws Exception {
        // Card 182 adds a write endpoint that copies files onto the disk, so it
        // inherits the v0.6.1 attack: a rebound page asking for /%61pi/... carries
        // no literal "/api/" for a raw match to see, while the container decodes
        // and dispatches it. Staged through the filter directly, because a
        // standalone MockMvc never decodes the target and would pass regardless.
        MockFilterChain chain = new MockFilterChain();
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockHttpServletRequest request = new MockHttpServletRequest("POST", "/%61pi/skills/install");
        request.setRequestURI("/%61pi/skills/install");
        request.setRemoteAddr("127.0.0.1");
        request.addHeader("Host", "evil.example");
        request.setContentType("application/json");
        request.setContent("{\"skill\":\"superpowers/brainstorming\"}".getBytes(StandardCharsets.UTF_8));

        new ApiLocalFence().doFilter(request, response, chain);

        assertEquals(404, response.getStatus());
        assertNull(chain.getRequest(), "the request must not reach the chain at all");
    }

    @Test
    void aReboundHostCannotInstall() throws Exception {
        // The claim "install sits behind the container fence" cannot be made by a
        // handler test: standalone MockMvc has no filter chain, so those only ever
        // exercise the controller's own check. The fence lives in the container.
        Path userRoot = skillRoots.resolve("user");
        Path projectRoot = skillRoots.resolve("project");
        Files.createDirectories(userRoot);
        Files.createDirectories(projectRoot);
        MockMvc skills = MockMvcBuilders.standaloneSetup(new SkillsController(userRoot, projectRoot))
                .addFilters(new ApiLocalFence())
                .build();

        skills.perform(post("http://attacker.example/api/skills/install")
                        .contentType("application/json")
                        .content("{\"skill\":\"superpowers/brainstorming\"}"))
                .andExpect(status().isNotFound());

        try (Stream<Path> left = Files.list(userRoot)) {
            assertEquals(List.of(), left.toList(), "nothing was copied");
        }
        // And the same request from loopback travels all the way through, so the
        // refusal above is the fence rather than a route that was never mapped.
        skills.perform(post("http://127.0.0.1/api/skills/install")
                        .contentType("application/json")
                        .content("{\"skill\":\"superpowers/brainstorming\"}"))
                .andExpect(status().isOk());
        assertTrue(Files.isRegularFile(userRoot.resolve("superpowers/brainstorming/SKILL.md")));
    }

    @Test
    void anOversizeExplainBodyIsRefusedBeforeItIsMaterialised() throws Exception {
        // The fence used to sit behind @RequestBody: Spring parsed the whole
        // JSON into an object first, so a rebound page's megabytes were read
        // before anything checked the Host. The filter is upstream of binding,
        // and while it is there it also refuses a declared length no honest
        // digest can reach.
        MockMvc explain = MockMvcBuilders.standaloneSetup(new ExplainController())
                .addFilters(new ApiLocalFence())
                .build();
        explain.perform(post("http://127.0.0.1/api/explain")
                        .contentType("application/json")
                        .content(new byte[ExplainController.MAX_BODY_BYTES + 1]))
                .andExpect(status().isPayloadTooLarge());
    }
}
