package dev.spectroscope.server;

import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.session.SessionStore;
import dev.spectroscope.server.starter.BundleController;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.Optional;
import java.util.UUID;

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
