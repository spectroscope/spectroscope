package dev.spectroscope.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.copilot.CopilotAccount;
import dev.spectroscope.core.copilot.CopilotAccount.State;
import dev.spectroscope.core.provider.CopilotProvider;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.Locale;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * Card 496: the doctor's Copilot sign-in row and the SDK row. The sign-in row
 * says signed in as the login or not, and is silent about tokens; the SDK row
 * names the version on the classpath.
 */
class DoctorCopilotSignInLineTest {

    @AfterEach
    void cleanHome() throws IOException {
        Files.deleteIfExists(SpectroConfig.USER_SETTINGS_PATH);
        Files.deleteIfExists(SpectroConfig.CONFIG_PATH);
    }

    @Test
    void aCliSignInNamesTheLoginAndTheWayIn() {
        DoctorCommand.Line line = DoctorCommand.copilotSignInLine(status(State.SIGNED_IN, "cli", "octo-fixture", null),
                true);

        assertEquals(DoctorCommand.Kind.PASS, line.kind());
        assertEquals("copilot sign-in: signed in as octo-fixture (Copilot CLI sign-in)", line.message());
    }

    @Test
    void theAppsOwnSignInNamesTheLoginAndTheWayIn() {
        DoctorCommand.Line line = DoctorCommand.copilotSignInLine(
                status(State.SIGNED_IN, "github", "octo-fixture", null), true);

        assertEquals(DoctorCommand.Kind.PASS, line.kind());
        assertEquals("copilot sign-in: signed in as octo-fixture (GitHub sign-in in spectroscope)", line.message());
    }

    @Test
    void notSignedInIsRedOnlyWhenCopilotIsTheProvider() {
        CopilotAccount.Status none = status(State.NOT_SIGNED_IN, null, null, null);

        DoctorCommand.Line selected = DoctorCommand.copilotSignInLine(none, true);
        assertEquals(DoctorCommand.Kind.FAIL, selected.kind());
        assertEquals("copilot sign-in: not signed in. Sign in from the copilot provider in the model menu.",
                selected.message());
        assertEquals(DoctorCommand.Kind.INFO, DoctorCommand.copilotSignInLine(none, false).kind());
    }

    @Test
    void aRefusalIsShownInTheWordsItCameIn() {
        DoctorCommand.Line line = DoctorCommand.copilotSignInLine(
                status(State.REFUSED, "github", null, "You do not have access to Copilot."), true);

        assertEquals(DoctorCommand.Kind.FAIL, line.kind());
        assertEquals("copilot sign-in: refused: You do not have access to Copilot.", line.message());
    }

    @Test
    void aWaitingSignInIsANote() {
        DoctorCommand.Line line = DoctorCommand.copilotSignInLine(
                status(State.WAITING, "github", null, null), true);

        assertEquals(DoctorCommand.Kind.INFO, line.kind());
        assertEquals("copilot sign-in: waiting for the code to be confirmed in the browser", line.message());
    }

    @Test
    void theSignInRowIsSilentAboutTokens() {
        for (State state : State.values()) {
            for (String method : new String[] {null, "cli", "github"}) {
                for (boolean selected : List.of(true, false)) {
                    String message = DoctorCommand.copilotSignInLine(
                            status(state, method, "octo-fixture", "a note"), selected).message();
                    assertFalse(message.toLowerCase(Locale.ROOT).contains("token"), message);
                }
            }
        }
    }

    @Test
    void theSdkRowNamesTheVersionOnTheClasspath() {
        DoctorCommand.Line line = DoctorCommand.copilotSdkLine(CopilotProvider.sdkVersion());

        assertEquals(DoctorCommand.Kind.INFO, line.kind());
        assertEquals("copilot sdk: copilot-sdk-java " + CopilotProvider.sdkVersion().orElseThrow(), line.message());
        assertEquals("copilot sdk: version unknown",
                DoctorCommand.copilotSdkLine(java.util.Optional.empty()).message());
    }

    // the drift guard: every sign-in provider has its row, and the SDK row is always there

    @Test
    void everySignInProviderHasASignInRowWhenItIsConfigured() throws IOException {
        assertFalse(SpectroConfig.signInProviders().isEmpty());
        for (String provider : SpectroConfig.signInProviders()) {
            String out = doctorOutputFor(provider);
            assertTrue(out.contains(provider + " sign-in: "),
                    "the doctor for the sign-in provider " + provider + " has no sign-in row:\n" + out);
        }
    }

    @Test
    void theSdkRowIsPrintedWhateverProviderIsConfigured() throws IOException {
        for (String provider : SpectroConfig.knownProviders()) {
            String out = doctorOutputFor(provider);
            assertTrue(out.contains("copilot sdk: "),
                    "the doctor for provider " + provider + " has no copilot sdk row:\n" + out);
        }
    }

    @Test
    void theSignInRowIsPrintedWhateverProviderIsConfigured() throws IOException {
        // Review of 2026-10-10: the row stood inside the copilot arm only, so a
        // user signed in to Copilot but configured for another provider never
        // saw it. The test home stores no sign-in, so the row reads "not signed
        // in": a failure only where copilot is the provider, a note elsewhere.
        for (String provider : SpectroConfig.knownProviders()) {
            String out = doctorOutputFor(provider);
            String row = out.lines().filter(l -> l.contains("copilot sign-in: ")).findFirst().orElse(null);
            assertTrue(row != null, "the doctor for provider " + provider + " has no copilot sign-in row:\n" + out);
            assertTrue(row.contains("not signed in"), row);
            assertEquals("copilot".equals(provider), row.contains("\u2717"),
                    "a missing sign-in is a failure only for the copilot provider: " + row);
        }
    }

    private static CopilotAccount.Status status(State state, String method, String login, String message) {
        return new CopilotAccount.Status(state, method, state == State.SIGNED_IN ? login : null,
                state == State.WAITING ? "ABCD-1234" : null,
                state == State.WAITING ? "https://github.com/login/device" : null, 0, message);
    }

    private static String doctorOutputFor(String provider) throws IOException {
        Files.createDirectories(SpectroConfig.USER_SETTINGS_PATH.getParent());
        Files.writeString(SpectroConfig.USER_SETTINGS_PATH, "{\"provider\": \"" + provider + "\"}");
        PrintStream original = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        System.setOut(new PrintStream(buffer, true, StandardCharsets.UTF_8));
        try {
            new DoctorCommand().call();
        } finally {
            System.setOut(original);
        }
        return buffer.toString(StandardCharsets.UTF_8);
    }
}
