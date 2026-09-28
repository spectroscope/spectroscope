package dev.spectroscope.server.llm;

import dev.spectroscope.core.tools.ToolPath;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 184 leg 2b: what speech needs, whether it is here, and the honest line
 * between the half this app can fetch and the half it must only report.
 */
class SttControllerTest {

    /** launchd's PATH for an app started from the Finder or the Dock. */
    private static final String LAUNCHD = "/usr/bin:/bin:/usr/sbin:/sbin";

    /** A home that is not absolute adds no per-user folder to the search. */
    private static final Path NO_HOME = Path.of("");

    /**
     * The real tool PATH lookup over {@code path}, with no package-manager
     * folder. Like every such search it ends in this host's system folders
     * ({@code /usr/bin}, {@code /bin}, {@code /usr/sbin}, {@code /sbin}). A test
     * that uses it plants its file in a folder of {@code path}, which is searched
     * before them.
     *
     * @param path the inherited PATH
     * @return the lookup the controller asks
     */
    private static Function<String, ToolPath.Lookup> lookupOver(String path) {
        return name -> ToolPath.locate(name, path, NO_HOME, List.of());
    }

    /**
     * A lookup that searched {@code folders} and found nothing. The tests that
     * need whisper-cli missing use it rather than a real search, because a real
     * search reaches this host's system folders, and a Linux distribution can
     * install whisper-cli into {@code /usr/bin}.
     *
     * @param folders the folders it reports as searched
     * @return a lookup that never finds a program
     */
    private static Function<String, ToolPath.Lookup> nothingFound(String... folders) {
        return name -> new ToolPath.Lookup(name, null, List.of(folders));
    }

    private static SttController controllerIn(Path models, Function<String, ToolPath.Lookup> locator) {
        return controllerIn(models, locator, "auto", false);
    }

    /** The full seam: also what the settings say and whether a hosted key exists. */
    private static SttController controllerIn(Path models, Function<String, ToolPath.Lookup> locator,
                                              String configured, boolean keyPresent) {
        return new SttController(models, locator, url -> new ByteArrayInputStream(new byte[0]),
                () -> configured, () -> keyPresent);
    }

    // ---- card 449: the app finds whisper-cli where the tools find programs ----

    /**
     * The owner's other host: whisper-cli installed with brew, the app started
     * from the Dock, and the status said missing. launchd hands the app four
     * folders and none of them is the Homebrew prefix; a temporary folder stands
     * in for that prefix here.
     */
    @Test
    void aFinderLaunchedAppFindsWhisperInTheHomebrewPrefix(@TempDir Path dir) throws Exception {
        Path prefix = Files.createDirectories(dir.resolve("homebrew").resolve("bin"));
        Path whisper = prefix.resolve("whisper-cli");
        Files.writeString(whisper, "#!/bin/sh\n");
        assertTrue(whisper.toFile().setExecutable(true));
        SttController controller = new SttController(dir,
                name -> ToolPath.locate(name, LAUNCHD, NO_HOME, List.of(prefix.toString())),
                url -> new ByteArrayInputStream(new byte[0]), () -> "auto", () -> false);

        Map<String, Object> state = controller.state();
        Map<String, Object> bin = sub(sub(state, "binaries"), "whisper-cli");

        assertEquals(true, bin.get("found"), "the prefix holds it: " + bin);
        assertEquals(whisper.toString(), bin.get("path"), "and the status names where it sits");
        assertNull(state.get("binaryHint"), "nothing to install when it is installed");
    }

    /** Still missing: the status says where it looked, and keeps its install line. */
    @Test
    void aMissingBinaryNamesTheFoldersItSearched(@TempDir Path dir) {
        List<String> folders = List.of("/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
        Map<String, Object> state = controllerIn(dir, nothingFound(folders.toArray(String[]::new)))
                .state();
        Map<String, Object> bin = sub(sub(state, "binaries"), "whisper-cli");

        assertEquals(false, bin.get("found"));
        assertNull(bin.get("path"));
        assertEquals(folders, bin.get("searched"), "the folders of the lookup, in its order");
        assertEquals(SttController.hintFor(System.getProperty("os.name", "")), state.get("binaryHint"));
    }

    /**
     * The folders in the status are the real lookup's, in its order, with the
     * package-manager folder first. Whether whisper-cli is found here depends on
     * this host, so the test does not say.
     */
    @Test
    void theFoldersInTheStatusAreTheLookupsOwn(@TempDir Path dir) throws Exception {
        Path prefix = Files.createDirectories(dir.resolve("homebrew").resolve("bin"));
        SttController controller = new SttController(dir,
                name -> ToolPath.locate(name, LAUNCHD, NO_HOME, List.of(prefix.toString())),
                url -> new ByteArrayInputStream(new byte[0]), () -> "auto", () -> false);

        Map<String, Object> bin = sub(sub(controller.state(), "binaries"), "whisper-cli");

        assertEquals(ToolPath.locate("whisper-cli", LAUNCHD, NO_HOME, List.of(prefix.toString()))
                .searched(), bin.get("searched"), "the folders of the one lookup, in its order");
        @SuppressWarnings("unchecked")
        List<String> searched = (List<String>) bin.get("searched");
        assertEquals(prefix.toString(), searched.getFirst());
        assertTrue(searched.contains("/usr/bin"), searched.toString());
    }

    /** The install line for macOS is the one it was before this card. */
    @Test
    void theMacHintStillNamesTheBrewFormula() {
        assertEquals("brew install whisper-cpp", SttController.hintFor("Mac OS X"));
        assertEquals("build whisper.cpp and put build/bin/whisper-cli on the PATH",
                SttController.hintFor("Linux"));
    }

    // ---- the two routes (card 187, the correction) --------------------------

    /**
     * The pane's whole job after the correction: say which way speech goes and
     * whether that way can run. A machine with a key and nothing installed is
     * READY, and a pane that answered "not installed" there would be describing
     * a route this call is not taking.
     */
    @Test
    void aKeyAndNothingInstalledIsAWorkingSetup(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, nothingFound(), "auto", true).state();

        assertEquals("hosted", state.get("route"));
        assertEquals(true, state.get("speechWorks"), "a key is all the hosted route needs");
        assertEquals(false, state.get("ready"), "and the LOCAL route is still honestly not ready");
    }

    @Test
    void noKeyFallsBackToTheLocalRouteAndSaysWhatItNeeds(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, nothingFound(), "auto", false).state();

        assertEquals("local", state.get("route"));
        assertEquals(false, state.get("speechWorks"));
        assertNotNull(state.get("binaryHint"), "the local route's obstacle is the one named");
    }

    @Test
    void anExplicitLocalChoiceIsNotOverriddenByTheMereExistenceOfAKey(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, nothingFound(), "local", true).state();
        assertEquals("local", state.get("route"));
    }

    /** The pane reports the dictation language the way it reports the provider. */
    @Test
    void thePaneReportsTheConfiguredDictationLanguage(@TempDir Path dir) {
        SttController controller = new SttController(dir, nothingFound(),
                url -> new ByteArrayInputStream(new byte[0]),
                () -> "auto", () -> false, () -> "de");

        assertEquals("de", controller.state().get("language"));
    }

    /** And the shorter seams default it to auto — the setting's own default. */
    @Test
    void theLanguageDefaultsToAuto(@TempDir Path dir) {
        assertEquals("auto", controllerIn(dir, nothingFound()).state().get("language"));
    }

    @Test
    void thePaneNamesTheHostedProviderItWouldUse(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, nothingFound(), "openai", true).state();

        @SuppressWarnings("unchecked")
        Map<String, Object> hosted = (Map<String, Object>) state.get("hosted");
        assertEquals(true, hosted.get("keyPresent"));
        assertEquals("OPENAI_API_KEY", hosted.get("keyEnv"));
        assertEquals("gpt-transcribe", hosted.get("model"));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> sub(Map<String, Object> state, String key) {
        return (Map<String, Object>) state.get(key);
    }

    @Test
    void saysTheModelIsAbsentWhenItIs(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, nothingFound()).state();
        assertEquals(false, sub(state, "model").get("present"));
        assertEquals(0L, sub(state, "model").get("bytes"));
        // The size it WOULD be, so a pane can say what the download costs before
        // anyone starts it.
        assertEquals(487_601_967L, sub(state, "model").get("expectedBytes"));
        assertEquals(false, state.get("ready"));
    }

    @Test
    void measuresTheModelItFinds(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve("ggml-small.bin"), "not really 487 MB");
        Map<String, Object> state = controllerIn(dir, nothingFound()).state();
        assertEquals(true, sub(state, "model").get("present"));
        assertEquals(17L, sub(state, "model").get("bytes"), "the size on disk, measured");
    }

    /** The whole point of the probe: readiness is a fact about right now, and a
     *  model can appear WHILE the server runs — which is what the download does. */
    @Test
    void noticesAModelThatAppearsAfterTheControllerWasBuilt(@TempDir Path dir) throws Exception {
        SttController controller = controllerIn(dir, nothingFound());
        assertEquals(false, sub(controller.state(), "model").get("present"));
        Files.writeString(dir.resolve("ggml-small.bin"), "arrived");
        assertEquals(true, sub(controller.state(), "model").get("present"),
                "probed on every call, never remembered from construction");
    }

    @Test
    void findsABinaryOnThePathAndNamesWhereItSits(@TempDir Path dir) throws Exception {
        Path bin = dir.resolve("bin");
        Files.createDirectories(bin);
        Path whisper = bin.resolve("whisper-cli");
        Files.writeString(whisper, "#!/bin/sh\n");
        whisper.toFile().setExecutable(true);

        Map<String, Object> one = sub(sub(controllerIn(dir, lookupOver(bin.toString())).state(),
                "binaries"), "whisper-cli");
        assertEquals(true, one.get("found"));
        assertEquals(whisper.toString(), one.get("path"));
    }

    /**
     * A plain file named whisper-cli in the first folder searched is not the
     * binary. Whether the search finds a copy further on depends on this host's
     * system folders, so the test pins only that this file is never the one
     * reported.
     */
    @Test
    void aFileThatCannotBeExecutedIsNeverTheReportedPath(@TempDir Path dir) throws Exception {
        Path bin = dir.resolve("bin");
        Files.createDirectories(bin);
        Path plain = bin.resolve("whisper-cli");
        Files.writeString(plain, "text");

        Map<String, Object> one = sub(sub(controllerIn(dir, lookupOver(bin.toString())).state(),
                "binaries"), "whisper-cli");
        @SuppressWarnings("unchecked")
        List<String> searched = (List<String>) one.get("searched");
        assertEquals(bin.toString(), searched.getFirst(),
                "the folder holding the file was searched first");
        assertNotEquals(plain.toString(), one.get("path"), "a file you cannot run is not a binary");
    }

    /** The line this card draws: the model is a button, the binaries are a
     *  sentence. An app that offered to `brew install` would be promising
     *  something it must not do and a DMG user could not use anyway. */
    @Test
    void reportsTheBinariesAndOffersAnInstructionRatherThanAButton(@TempDir Path dir) {
        Map<String, Object> state = controllerIn(dir, nothingFound()).state();
        Map<String, Object> bins = sub(state, "binaries");
        assertEquals(false, sub(bins, "whisper-cli").get("found"));
        assertNull(sub(bins, "whisper-cli").get("path"));
        // Card 187 step 5.4: the browser converts its own recording, so this path
        // needs ONE binary. A pane that still asked for ffmpeg would be asking a
        // reader to install something nothing here runs.
        assertNull(bins.get("ffmpeg"), "ffmpeg is not a requirement of this path any more");
        assertFalse(String.valueOf(state.get("binaryHint")).contains("ffmpeg"),
                "and the instruction must not name it either: " + state.get("binaryHint"));
        assertNotNull(state.get("binaryHint"), "it says what to run, on this machine");
        assertFalse(String.valueOf(state.get("binaryHint")).isBlank());
    }

    @Test
    void staysSilentAboutTheInstructionOnceTheBinaryIsThere(@TempDir Path dir) throws Exception {
        Path bin = dir.resolve("bin");
        Files.createDirectories(bin);
        for (String name : SttController.BINARIES) {
            Path exe = bin.resolve(name);
            Files.writeString(exe, "#!/bin/sh\n");
            exe.toFile().setExecutable(true);
        }
        Files.writeString(dir.resolve("ggml-small.bin"), "present");

        Map<String, Object> state = controllerIn(dir, lookupOver(bin.toString())).state();
        assertNull(state.get("binaryHint"), "nothing to advise when nothing is missing");
        assertEquals(true, state.get("ready"), "model and binary: ready");
    }

    /** The digest is the script's, and the script's was measured against the
     *  real download. A pane may say "verified" only because of this. */
    @Test
    void pinsTheSameDigestTheSetupScriptDoes() throws Exception {
        String script = Files.readString(Path.of("..", "scripts", "setup-stt.sh"));
        assertTrue(script.contains(SttController.MODEL_SHA256),
                "the controller and the script must pin ONE digest, not two");
        assertTrue(script.contains(SttController.MODEL_URL), "and one url");
    }
}
