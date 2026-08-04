package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
    }

    @Test
    void aReboundHostGetsNoProspectiveTreeEither() throws Exception {
        // The fence is the floor under every read here (card 74). A new read
        // endpoint inherits it; a test says so rather than trusting it.
        Files.writeString(configured.resolve("notes.md"), "already here");
        servingConfigured(configured.toString())
                .perform(get("http://evil.example/api/files").param("scope", "prospective"))
                .andExpect(status().isNotFound());
        servingConfigured(configured.toString())
                .perform(get("http://localhost/api/files")
                        .param("scope", "prospective")
                        .with(request -> {
                            request.setRemoteAddr("203.0.113.7"); // TEST-NET, not loopback
                            return request;
                        }))
                .andExpect(status().isNotFound());
    }
}
