package dev.spectroscope.cli;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 312: the doctor asks a llama.cpp server whether it is READY, instead of
 * connecting blind.
 *
 * <p>The distinction is not cosmetic. {@code GET /health} answers <b>503</b>
 * while a model is still loading, and doctor's shared reachability probe calls
 * anything at or above 500 "unreachable" — so a server that is up, correct, and
 * forty seconds from serving would be reported as absent, and the operator
 * would go looking for a process that is already running.</p>
 */
class LlamaCppDoctorTest {

    // ---- which check fits -----------------------------------------------

    @Test
    void llamacppGetsItsOwnCheckRatherThanTheGenericOpenAiOne() {
        assertEquals(DoctorCommand.ProviderCheck.LLAMACPP,
                DoctorCommand.providerCheckFor("llamacpp"));
    }

    @Test
    void lmStudioKeepsTheGenericOpenAiCheck() {
        // Bitten separately: a single "llamacpp is routed" assertion would pass
        // just as well if every openai-compatible provider had been rerouted.
        assertEquals(DoctorCommand.ProviderCheck.OPENAI_COMPAT,
                DoctorCommand.providerCheckFor("lmstudio"));
    }

    @Test
    void everyKnownProviderStillHasACheck() {
        // Card 164: doctor's switch knew three of seven and called the rest
        // unknown. A new provider name must not reopen that hole.
        for (String provider : dev.spectroscope.core.config.SpectroConfig.knownProviders()) {
            assertNotEquals(null, DoctorCommand.providerCheckFor(provider),
                    "doctor has no check for the known provider " + provider);
        }
    }

    // ---- the address field ----------------------------------------------

    @Test
    void theAddressNoteNamesLlamacppsOwnField() {
        assertEquals("llamacppBaseUrl", DoctorCommand.addressFieldFor("llamacpp"));
    }

    // ---- what /health actually says --------------------------------------

    @Test
    void aReadyServerPasses() {
        List<DoctorCommand.Line> lines =
                DoctorCommand.llamaCppLines("http://localhost:8080", 200, 4096);
        assertEquals(DoctorCommand.Kind.PASS, lines.get(0).kind());
        assertTrue(lines.get(0).message().contains("http://localhost:8080"),
                "the line prints the address a run would really dial");
    }

    @Test
    void aLoadingServerIsNotReportedAsMissing() {
        // 503 with a body of {"error":{"code":503,"message":"Loading model"}}.
        // The server IS there; it is the one state a blind connect gets wrong.
        List<DoctorCommand.Line> lines =
                DoctorCommand.llamaCppLines("http://localhost:8080", 503, 0);
        assertNotEquals(DoctorCommand.Kind.FAIL, lines.get(0).kind(),
                "a loading llama-server is running — calling it unreachable sends "
                        + "the operator hunting for a process that is already up");
        assertTrue(lines.get(0).message().contains("loading"),
                "the line has to say WHICH state it found: " + lines.get(0).message());
    }

    @Test
    void anAbsentServerFails() {
        List<DoctorCommand.Line> lines =
                DoctorCommand.llamaCppLines("http://localhost:8080", 0, 0);
        assertEquals(DoctorCommand.Kind.FAIL, lines.get(0).kind());
        assertTrue(lines.get(0).message().contains("unreachable"));
    }

    // ---- what /props adds -------------------------------------------------

    @Test
    void aKnownWindowIsPrintedAsMeasuredNotGuessed() {
        List<DoctorCommand.Line> lines =
                DoctorCommand.llamaCppLines("http://localhost:8080", 200, 4096);
        String all = lines.stream().map(DoctorCommand.Line::message).reduce("", (a, b) -> a + "\n" + b);
        assertTrue(all.contains("4096"),
                "the window the server reported belongs in the output: " + all);
    }

    @Test
    void anUnknownWindowIsNotPrintedAsAZero() {
        // 0 is "nothing was learned", not "a zero-token context". Printing it as
        // a number would be a measurement the doctor never made.
        List<DoctorCommand.Line> lines =
                DoctorCommand.llamaCppLines("http://localhost:8080", 200, 0);
        String all = lines.stream().map(DoctorCommand.Line::message).reduce("", (a, b) -> a + "\n" + b);
        assertTrue(!all.contains("0 tokens"), "a zero window must never print as a size: " + all);
    }

    @Test
    void theModelIdIsCalledDecorativeBecauseItIs() {
        // Measured 2026-08-30 against b10107: a completion naming a model that
        // does not exist came back from the loaded one. An operator who thinks
        // the model field selects something will keep changing it and keep
        // getting the same model.
        List<DoctorCommand.Line> lines =
                DoctorCommand.llamaCppLines("http://localhost:8080", 200, 4096);
        String all = lines.stream().map(DoctorCommand.Line::message).reduce("", (a, b) -> a + "\n" + b);
        assertTrue(all.contains("ignore") || all.contains("one model"),
                "doctor should say the model field is not a chooser: " + all);
    }

    // ---- vision ------------------------------------------------------------

    @Test
    void theVisionLineForLlamacppDoesNotFallIntoTheUnknownDefault() {
        String line = DoctorCommand.visionLine("llamacpp", "whatever");
        assertTrue(!line.contains("vision: unknown for"),
                "llama.cpp answers modalities.vision at /props — the one provider "
                        + "besides the built-in runtime where doctor need not shrug: " + line);
    }
}
