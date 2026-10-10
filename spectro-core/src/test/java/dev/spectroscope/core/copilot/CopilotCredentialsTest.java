package dev.spectroscope.core.copilot;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Card 495, criterion 3: the token file is owner-only, like the key file of writeApiKey. */
class CopilotCredentialsTest {

    @TempDir
    Path home;

    private static CopilotCredentials.Stored stored(String login, String token) {
        return new CopilotCredentials.Stored(CopilotCredentials.Method.GITHUB, login, token, 1_000L,
                "ghr_" + "fixtureRefresh", 2_000L);
    }

    @Test
    void aSavedSignInIsOwnerOnlyAndReadsBack() throws Exception {
        CopilotCredentials store = new CopilotCredentials(home.resolve(".spectro").resolve("copilot-account.json"));

        store.save(stored("octo-fixture", "ghu_" + "fixtureAccess"));

        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(store.path())));
        assertEquals(stored("octo-fixture", "ghu_fixtureAccess"), store.load().orElseThrow());
    }

    @Test
    void theTemporaryFileIsOwnerOnlyWhileTheTokenIsInIt() throws Exception {
        List<String> modes = new ArrayList<>();
        List<Boolean> holdsToken = new ArrayList<>();
        CopilotCredentials store = new CopilotCredentials(home.resolve("copilot-account.json"), temp -> {
            modes.add(PosixFilePermissions.toString(Files.getPosixFilePermissions(temp)));
            holdsToken.add(Files.readString(temp).contains("fixtureAccess"));
        });

        store.save(stored("octo-fixture", "ghu_" + "fixtureAccess"));

        assertEquals(List.of("rw-------"), modes, "the mode of the temporary file before it is moved");
        assertEquals(List.of(true), holdsToken, "the observation saw the written token, not an empty file");
    }

    @Test
    void aFileThatWasWiderBeforeIsOwnerOnlyAfterASave() throws Exception {
        Path file = home.resolve("copilot-account.json");
        Files.writeString(file, "{}");
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString("rw-r--r--"));
        CopilotCredentials store = new CopilotCredentials(file);

        store.save(stored("octo-fixture", "ghu_" + "fixtureAccess"));

        assertEquals("rw-------", PosixFilePermissions.toString(Files.getPosixFilePermissions(file)));
    }

    @Test
    void noTemporaryFileIsLeftBeside() throws Exception {
        CopilotCredentials store = new CopilotCredentials(home.resolve("copilot-account.json"));

        store.save(stored("octo-fixture", "ghu_" + "fixtureAccess"));
        store.save(stored("other-fixture", "ghu_" + "fixtureSecond"));

        try (var files = Files.list(home)) {
            assertEquals(1, files.count(), "only the account file remains");
        }
    }

    @Test
    void aSecondSaveReplacesTheFirst() throws Exception {
        CopilotCredentials store = new CopilotCredentials(home.resolve("copilot-account.json"));

        store.save(stored("octo-fixture", "ghu_" + "fixtureAccess"));
        store.save(stored("other-fixture", "ghu_" + "fixtureSecond"));

        assertEquals("other-fixture", store.load().orElseThrow().login());
        assertFalse(Files.readString(store.path()).contains("fixtureAccess"), "the first token is gone");
    }

    @Test
    void deleteRemovesTheFileAndLoadIsEmptyAfter() throws Exception {
        CopilotCredentials store = new CopilotCredentials(home.resolve("copilot-account.json"));
        store.save(stored("octo-fixture", "ghu_" + "fixtureAccess"));

        assertTrue(store.delete());

        assertFalse(Files.exists(store.path()));
        assertTrue(store.load().isEmpty());
        assertFalse(store.delete(), "nothing left to delete");
    }

    @Test
    void toStringShowsNoToken() {
        String text = stored("octo-fixture", "ghu_" + "fixtureAccess").toString();

        assertFalse(text.contains("fixtureAccess"), text);
        assertFalse(text.contains("fixtureRefresh"), text);
        assertTrue(text.contains("GITHUB"), text);
    }

    @Test
    void anUnreadableFileIsNoSignIn() throws Exception {
        Path file = home.resolve("copilot-account.json");
        Files.writeString(file, "not json");

        assertTrue(new CopilotCredentials(file).load().isEmpty());
    }
}
