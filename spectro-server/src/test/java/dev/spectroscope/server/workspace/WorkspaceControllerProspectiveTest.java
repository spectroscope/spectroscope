package dev.spectroscope.server.workspace;

import dev.spectroscope.server.session.SessionWorkspaces;
import dev.spectroscope.server.web.ApiLocalFence;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The folder before the first run. {@code workspace_info} announces a
 * PROSPECTIVE workspace on connect — the folder a run started now would use —
 * and for a configured workspace that folder is usually already on disk. The
 * pane printed its path and listed nothing, because the only way to ask
 * {@code /api/files} anything was with a session id, and no session exists yet.
 *
 * <p>{@code scope=prospective} is the missing question. The client contributes
 * no path: the server names the folder from the configured workspace with the
 * same read-only {@code locate()} the announcement uses, so the only directory
 * this can ever list is the one the announcement already printed.</p>
 */
class WorkspaceControllerProspectiveTest {

    @TempDir
    Path configured;

    private MockMvc servingConfigured(String workspace) {
        return MockMvcBuilders.standaloneSetup(new WorkspaceController(() -> workspace)).build();
    }

    @Test
    void theFirstRunsFolderIsListedBeforeAnySessionExists() throws Exception {
        Files.writeString(configured.resolve("notes.md"), "already here");
        Files.createDirectory(configured.resolve("src"));

        servingConfigured(configured.toString())
                .perform(get("http://localhost/api/files").param("scope", "prospective"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.root").value(configured.getFileName().toString()))
                .andExpect(jsonPath("$.entries[0].name").value("src"))
                .andExpect(jsonPath("$.entries[1].name").value("notes.md"));
    }

    @Test
    void withNoConfiguredWorkspaceThereIsNoFolderToName() throws Exception {
        // This is the "random" install: the folder is keyed by a session id that
        // does not exist yet, and inventing one would mint the session.
        servingConfigured(null)
                .perform(get("http://localhost/api/files").param("scope", "prospective"))
                .andExpect(status().isConflict());
        servingConfigured("   ")
                .perform(get("http://localhost/api/files").param("scope", "prospective"))
                .andExpect(status().isConflict());
    }

    @Test
    void aConfiguredFolderThatIsNotOnDiskYetIsNotATree() throws Exception {
        servingConfigured(configured.resolve("not-created-yet").toString())
                .perform(get("http://localhost/api/files").param("scope", "prospective"))
                .andExpect(status().isNotFound());
    }

    @Test
    void theSessionParameterCannotSteerTheProspectiveListing() throws Exception {
        // The prospective folder comes from the config and from nothing else. A
        // session id riding along must neither redirect the read nor turn a
        // malformed one into a 400 about a lookup that never happens.
        Files.writeString(configured.resolve("notes.md"), "already here");
        String elsewhere = "prospective-" + System.nanoTime();
        SessionWorkspaces.resolved(elsewhere, System.getProperty("java.io.tmpdir"));

        servingConfigured(configured.toString())
                .perform(get("http://localhost/api/files")
                        .param("scope", "prospective")
                        .param("session", elsewhere))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.root").value(configured.getFileName().toString()));
    }

    @Test
    void anUnknownScopeIsRefusedRatherThanQuietlyTreatedAsASessionRead() throws Exception {
        servingConfigured(configured.toString())
                .perform(get("http://localhost/api/files").param("scope", "everything"))
                .andExpect(status().isBadRequest());
        servingConfigured(configured.toString())
                .perform(get("http://localhost/api/file").param("path", "notes.md").param("scope", "everything"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void anEmptyScopeIsNoScopeAtAll() throws Exception {
        // `?scope=` has named nothing, so it reads as the session default and
        // lands on the same 409 an absent scope does. Refusing it would make the
        // empty field of a form a different endpoint, which is a trap and not a
        // check; every value that IS a word and is not one of ours still 400s.
        servingConfigured(configured.toString())
                .perform(get("http://localhost/api/files").param("scope", ""))
                .andExpect(status().isConflict());
        servingConfigured(configured.toString())
                .perform(get("http://localhost/api/file").param("path", "notes.md").param("scope", ""))
                .andExpect(status().isConflict());
    }

    // ---- the preview, on the same folder the tree just listed -----------------

    @Test
    void thePreviewOpensAFileFromTheFolderTheTreeListed() throws Exception {
        // The half that shipped without a test. A tree that lists a file and an
        // endpoint that will not open it is half an answer, and before the first
        // run the tree is the ONLY thing the pane has.
        Files.writeString(configured.resolve("notes.md"), "already here");

        servingConfigured(configured.toString())
                .perform(get("http://localhost/api/file")
                        .param("path", "notes.md")
                        .param("scope", "prospective"))
                .andExpect(status().isOk())
                .andExpect(content().string("already here"));
    }

    @Test
    void thePreviewsSandboxHoldsOnTheProspectiveRootToo() throws Exception {
        // Same root, same sandbox: the prospective read is a different way of
        // NAMING the folder, never a different set of rules inside it.
        Files.writeString(configured.resolve("notes.md"), "already here");
        Files.writeString(configured.resolve(".secret"), "hidden");
        Path outside = Files.createTempDirectory("outside-the-workspace");
        Files.writeString(outside.resolve("stolen.txt"), "not yours");
        Files.createSymbolicLink(configured.resolve("escape.txt"), outside.resolve("stolen.txt"));

        MockMvc mvc = servingConfigured(configured.toString());
        for (String path : new String[] {"../stolen.txt", "escape.txt", ".secret", "nothing-here.md"}) {
            mvc.perform(get("http://localhost/api/file").param("path", path).param("scope", "prospective"))
                    .andExpect(status().isNotFound());
        }
    }

    @Test
    void theSessionParameterCannotSteerTheProspectiveRead() throws Exception {
        // The tree's rule, applied to the bytes: prospective takes nothing from
        // the caller, so an id riding along must not redirect which file opens.
        Files.writeString(configured.resolve("notes.md"), "already here");
        Path elsewhereDir = Files.createTempDirectory("elsewhere");
        Files.writeString(elsewhereDir.resolve("notes.md"), "the other folder");
        String elsewhere = "prospective-file-" + System.nanoTime();
        SessionWorkspaces.resolved(elsewhere, elsewhereDir.toString());

        servingConfigured(configured.toString())
                .perform(get("http://localhost/api/file")
                        .param("path", "notes.md")
                        .param("scope", "prospective")
                        .param("session", elsewhere))
                .andExpect(status().isOk())
                .andExpect(content().string("already here"));
    }

    @Test
    void withNoConfiguredWorkspaceThereIsNoFileToOpenEither() throws Exception {
        servingConfigured(null)
                .perform(get("http://localhost/api/file").param("path", "notes.md").param("scope", "prospective"))
                .andExpect(status().isConflict());
    }

    // ---- the fence ------------------------------------------------------------

    @Test
    void aReboundHostGetsNoProspectiveTreeOrFileEither() throws Exception {
        // The handler's own check, which is the second of the two layers.
        Files.writeString(configured.resolve("notes.md"), "already here");
        MockMvc mvc = servingConfigured(configured.toString());
        mvc.perform(get("http://evil.example/api/files").param("scope", "prospective"))
                .andExpect(status().isNotFound());
        mvc.perform(get("http://evil.example/api/file").param("path", "notes.md").param("scope", "prospective"))
                .andExpect(status().isNotFound());
        mvc.perform(get("http://localhost/api/files")
                        .param("scope", "prospective")
                        .with(request -> {
                            request.setRemoteAddr("203.0.113.7"); // TEST-NET, not loopback
                            return request;
                        }))
                .andExpect(status().isNotFound());
        mvc.perform(get("http://localhost/api/file")
                        .param("path", "notes.md")
                        .param("scope", "prospective")
                        .with(request -> {
                            request.setRemoteAddr("203.0.113.7");
                            return request;
                        }))
                .andExpect(status().isNotFound());
    }

    @Test
    void bothReadsSitBehindTheContainerFenceAndNotOnlyBehindTheirOwnCheck() throws Exception {
        // The claim "these sit behind ApiLocalFence" cannot be made by the tests
        // above: a standalone MockMvc has no filter chain, so they only ever
        // exercised the handler's own isLocalOrigin. That is exactly the shape
        // that let /%61pi/config through in v0.6.1 while the MockMvc tests stayed
        // green — the fence lives in the container, so the container is where it
        // has to be asked.
        Files.writeString(configured.resolve("notes.md"), "already here");
        MockMvc fenced = MockMvcBuilders.standaloneSetup(new WorkspaceController(() -> configured.toString()))
                .addFilters(new ApiLocalFence())
                .build();

        fenced.perform(get("http://evil.example/api/files").param("scope", "prospective"))
                .andExpect(status().isNotFound());
        fenced.perform(get("http://evil.example/api/file").param("path", "notes.md").param("scope", "prospective"))
                .andExpect(status().isNotFound());
        // And a loopback caller still travels through it to the real answer, so
        // the refusal above is the fence and not a filter that swallows all four.
        fenced.perform(get("http://127.0.0.1/api/files").param("scope", "prospective"))
                .andExpect(status().isOk());
        fenced.perform(get("http://127.0.0.1/api/file").param("path", "notes.md").param("scope", "prospective"))
                .andExpect(status().isOk())
                .andExpect(content().string("already here"));
    }

    @Test
    void anEncodedPrefixDoesNotWalkPastTheFenceIntoTheWorkspace() throws Exception {
        // The v0.6.1 attack aimed at this endpoint. It cannot be staged through
        // MockMvc at all (standalone never decodes the target), so the filter is
        // driven directly, the way ApiLocalFenceTest drives it for /api/config.
        for (String uri : new String[] {"/%61pi/files", "/%61pi/file"}) {
            MockFilterChain chain = new MockFilterChain();
            MockHttpServletResponse response = new MockHttpServletResponse();
            MockHttpServletRequest rebound = new MockHttpServletRequest("GET", uri);
            rebound.setRequestURI(uri);
            rebound.setRemoteAddr("127.0.0.1"); // a rebound page really does reach loopback
            rebound.addHeader("Host", "evil.example");
            rebound.addParameter("scope", "prospective");

            new ApiLocalFence().doFilter(rebound, response, chain);

            assertEquals(404, response.getStatus(), uri);
            assertNull(chain.getRequest(), uri + " must not reach the chain at all");
        }
    }
}
