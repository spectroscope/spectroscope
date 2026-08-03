package dev.spectroscope.server;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The read fence on the workspace endpoints (card 74). Dropping
 * {@code @CrossOrigin} stops a plain cross-origin read, but not DNS rebinding:
 * a rebound page (evil.example to 127.0.0.1) is same-origin to itself and can
 * read whatever an unfenced GET answers. The Host header is the half a page's
 * JavaScript cannot forge, so it is the check that refuses it.
 *
 * <p>Driven through the real request mapping rather than a direct call, because
 * the thing under test is what the endpoint does with a request that arrives on
 * loopback carrying a foreign Host. A direct call cannot state that.</p>
 */
class WorkspaceControllerFenceTest {

    @TempDir
    Path root;

    private String session;
    private MockMvc mvc;

    @BeforeEach
    void aSessionWithARealWorkspace() throws Exception {
        session = "ws-fence-" + System.nanoTime();
        SessionWorkspaces.resolved(session, root.toString());
        Files.writeString(root.resolve("notes.txt"), "workspace content");
        mvc = MockMvcBuilders.standaloneSetup(new WorkspaceController()).build();
    }

    @Test
    void aReboundHostGetsNeitherTheTreeNorTheFileBytes() throws Exception {
        // Loopback peer, attacker Host: exactly the shape of a rebinding read.
        mvc.perform(get("http://evil.example/api/files").param("session", session))
                .andExpect(status().isNotFound());
        mvc.perform(get("http://evil.example/api/file")
                        .param("session", session)
                        .param("path", "notes.txt"))
                .andExpect(status().isNotFound());
    }

    @Test
    void aLoopbackCallerStillGetsBoth() throws Exception {
        mvc.perform(get("http://127.0.0.1/api/files").param("session", session))
                .andExpect(status().isOk());
        mvc.perform(get("http://localhost/api/file")
                        .param("session", session)
                        .param("path", "notes.txt"))
                .andExpect(status().isOk())
                .andExpect(content().string("workspace content"));
    }

    @Test
    void aNonLoopbackPeerGetsNothingEvenWithALocalhostHost() throws Exception {
        mvc.perform(get("http://localhost/api/files")
                        .param("session", session)
                        .with(request -> {
                            request.setRemoteAddr("203.0.113.7"); // TEST-NET, not loopback
                            return request;
                        }))
                .andExpect(status().isNotFound());
    }
}
