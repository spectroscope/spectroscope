package dev.spectroscope.server.llm;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.SttRunnerChoice;
import dev.spectroscope.core.config.SttStreaming;
import dev.spectroscope.core.tools.ToolPath;
import dev.spectroscope.server.fleet.FleetController;
import dev.spectroscope.server.localmodel.LocalModelDownload;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Function;

/**
 * What speech-to-text needs, whether it is here, and the one half of it this app
 * can honestly fetch (card 184 leg 2b).
 *
 * <p>The owner's rule: <b>a DMG user has no terminal.</b> `scripts/setup-stt.sh`
 * does two things and only one of them belongs in a window.</p>
 *
 * <ul>
 *   <li><b>The model</b> is a sha-pinned download, which is exactly what
 *       {@link LocalModelDownload} already does for the local chat models. The
 *       pin here is not invented: it is the one the script carries, and it was
 *       measured against the installed file before it was written down.</li>
 *   <li><b>The binary</b> (`whisper-cli`) the script installs
 *       through brew or apt. This app must not drive a package manager, and a
 *       DMG user has neither. So they are PROBED and REPORTED — found at a path,
 *       or honestly not found with the one command that works on this machine.
 *       Never a button that cannot keep its promise; the same answer card 100
 *       reached for `llama-server`.</li>
 * </ul>
 *
 * <p><b>Where the binary is looked for</b> (card 449): on the PATH the agent's
 * tool shells get, through {@link ToolPath#locate(String)}. An app started from
 * the Finder or the Dock inherits launchd's {@code /usr/bin:/bin:/usr/sbin:/sbin},
 * and Homebrew puts {@code whisper-cli} in {@code /opt/homebrew/bin} or
 * {@code /usr/local/bin}; the inherited PATH alone reported it missing. The
 * status names the folders searched, found or not.</p>
 */
@RestController
public final class SttController {

    /** The pinned model: name, digest and size, matching scripts/setup-stt.sh. */
    static final String MODEL_FILE = "ggml-small.bin";
    static final String MODEL_SHA256 = "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b";
    static final long MODEL_BYTES = 487_601_967L;
    static final String MODEL_URL =
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";

    /** The binaries the pipeline shells out to. One, since card 187 step 5.4:
     *  the browser converts its own recording, so ffmpeg left this path — with
     *  it went the licence question, because whisper.cpp is MIT. */
    static final String[] BINARIES = {"whisper-cli"};

    private final Path modelsDir;
    /** Where a program sits and which folders were searched, asked per call. */
    private final Function<String, ToolPath.Lookup> locator;
    private final LocalModelDownload download;
    /** The {@code sttProvider} setting, read per call. */
    private final java.util.function.Supplier<String> configured;
    /** Whether the hosted provider has a key, read per call. */
    private final java.util.function.BooleanSupplier keyPresent;
    /** The {@code sttLanguage} setting, read per call like the provider. */
    private final java.util.function.Supplier<String> language;
    /** The model the live socket runs (card 527), read per call: the
     *  {@code sttModel} setting, then the env, then the default file. */
    private final java.util.function.Supplier<Path> liveModel;
    /** The {@code sttRunner} setting, read per call (card 528). */
    private final java.util.function.Supplier<String> runner;
    /** The resident whisper-server's state, read per call (card 528). */
    private final java.util.function.Supplier<WhisperServerRunner.Status> serverStatus;

    public SttController() {
        this(Path.of(System.getProperty("user.home"), ".spectro", "models"),
                ToolPath::locate, SttController::httpFetch,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none()).sttProvider(),
                () -> SpectroConfig.hasApiKey(HostedTranscriber.KEY_ENV),
                () -> SpectroConfig.load(SpectroConfig.Overrides.none()).sttLanguage(),
                TranscribeController::configuredModelPath,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none()).sttRunner(),
                () -> SpeechRunners.shared().serverStatus());
    }

    /** Seam for tests: a models dir, the program lookup, and the HTTP leg. */
    SttController(Path modelsDir, Function<String, ToolPath.Lookup> locator,
                  LocalModelDownload.Fetcher fetcher) {
        this(modelsDir, locator, fetcher, () -> SttRoute.AUTO, () -> false);
    }

    /** Seam for tests: also what the settings say and whether a hosted key exists. */
    SttController(Path modelsDir, Function<String, ToolPath.Lookup> locator,
                  LocalModelDownload.Fetcher fetcher,
                  java.util.function.Supplier<String> configured,
                  java.util.function.BooleanSupplier keyPresent) {
        this(modelsDir, locator, fetcher, configured, keyPresent, () -> "auto");
    }

    /**
     * The full seam: also what the settings say and whether a hosted key exists.
     *
     * @param modelsDir where the whisper model lives
     * @param locator where a program sits: {@link ToolPath#locate(String)} in
     *                production, a lookup over given folders in a test
     * @param fetcher the HTTP leg of the model download
     * @param configured reads {@code sttProvider} — a supplier, because it can
     *                   change while the server runs and this pane must not
     *                   describe the settings as they were at boot
     * @param keyPresent whether the hosted provider's key is set somewhere
     * @param language reads {@code sttLanguage} — a supplier for the same
     *                 reason {@code configured} is one
     */
    SttController(Path modelsDir, Function<String, ToolPath.Lookup> locator,
                  LocalModelDownload.Fetcher fetcher,
                  java.util.function.Supplier<String> configured,
                  java.util.function.BooleanSupplier keyPresent,
                  java.util.function.Supplier<String> language) {
        this(modelsDir, locator, fetcher, configured, keyPresent, language,
                () -> modelsDir.resolve(MODEL_FILE));
    }

    /**
     * The full seam with the live model.
     *
     * @param modelsDir where the whisper model lives
     * @param locator where a program sits
     * @param fetcher the HTTP leg of the model download
     * @param configured reads {@code sttProvider}
     * @param keyPresent whether the hosted provider's key is set somewhere
     * @param language reads {@code sttLanguage}
     * @param liveModel the model file the live socket runs, read per call, so
     *                  {@code localLive} answers what the socket will do
     */
    SttController(Path modelsDir, Function<String, ToolPath.Lookup> locator,
                  LocalModelDownload.Fetcher fetcher,
                  java.util.function.Supplier<String> configured,
                  java.util.function.BooleanSupplier keyPresent,
                  java.util.function.Supplier<String> language,
                  java.util.function.Supplier<Path> liveModel) {
        this(modelsDir, locator, fetcher, configured, keyPresent, language, liveModel,
                () -> SpectroConfig.STT_RUNNER_AUTO, () -> new WhisperServerRunner.Status(false, null));
    }

    /**
     * The full seam with the speech runner (card 528).
     *
     * @param modelsDir where the whisper model lives
     * @param locator where a program sits
     * @param fetcher the HTTP leg of the model download
     * @param configured reads {@code sttProvider}
     * @param keyPresent whether the hosted provider's key is set somewhere
     * @param language reads {@code sttLanguage}
     * @param liveModel the model file the live socket runs
     * @param runner reads {@code sttRunner}
     * @param serverStatus the resident whisper-server's state
     */
    SttController(Path modelsDir, Function<String, ToolPath.Lookup> locator,
                  LocalModelDownload.Fetcher fetcher,
                  java.util.function.Supplier<String> configured,
                  java.util.function.BooleanSupplier keyPresent,
                  java.util.function.Supplier<String> language,
                  java.util.function.Supplier<Path> liveModel,
                  java.util.function.Supplier<String> runner,
                  java.util.function.Supplier<WhisperServerRunner.Status> serverStatus) {
        this.runner = runner;
        this.serverStatus = serverStatus;
        this.liveModel = liveModel;
        this.modelsDir = modelsDir;
        this.locator = locator;
        this.download = new LocalModelDownload(modelsDir, MODEL_FILE, MODEL_SHA256, MODEL_BYTES,
                fetcher, MODEL_URL);
        this.configured = configured;
        this.keyPresent = keyPresent;
        this.language = language;
    }

    /**
     * The live state of speech-to-text, probed on every call.
     *
     * <p>Probed rather than remembered because a model can appear WHILE the
     * server runs — which is precisely what the download below does, and what
     * {@code TranscribeController} used to miss by deciding readiness in its
     * constructor.</p>
     *
     * @return 200 with model, binaries and readiness; 404 for a foreign caller
     */
    @GetMapping("/api/stt/status")
    public ResponseEntity<Map<String, Object>> status(HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)
                || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(state());
    }

    /**
     * Fetch the pinned model. The digest is verified before the file is put in
     * place, so a half or wrong download never becomes a usable-looking one.
     *
     * @return 200 with the download's state; 404 for a foreign caller
     */
    @PostMapping("/api/stt/model/download")
    public ResponseEntity<Map<String, Object>> startDownload(HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)
                || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        download.start();
        return ResponseEntity.ok(state());
    }

    /** Visible for tests: the whole answer, without a servlet. */
    Map<String, Object> state() {
        Path model = modelsDir.resolve(MODEL_FILE);
        boolean present = Files.isRegularFile(model);
        Map<String, Object> modelInfo = new LinkedHashMap<>();
        modelInfo.put("file", MODEL_FILE);
        modelInfo.put("path", model.toString());
        modelInfo.put("present", present);
        modelInfo.put("expectedBytes", MODEL_BYTES);
        modelInfo.put("bytes", present ? sizeOf(model) : 0L);

        Map<String, Object> bins = new LinkedHashMap<>();
        boolean allBins = true;
        for (String name : BINARIES) {
            ToolPath.Lookup at = locator.apply(name);
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("found", at.isFound());
            one.put("path", at.found());
            // Where it looked, found or not: a reader told "missing" after an
            // install needs the folder list to see which one was never searched.
            one.put("searched", at.searched());
            bins.put(name, one);
            allBins &= at.isFound();
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("model", modelInfo);
        out.put("binaries", bins);
        out.put("ready", present && allBins);
        // The one instruction that is true on THIS machine. Never a download
        // button: this app does not drive a package manager, and a DMG user has
        // none to drive.
        out.put("binaryHint", allBins ? null : hintFor(System.getProperty("os.name", "")));
        out.put("download", download.status());
        // Which way a recording would go RIGHT NOW, and whether that way can run.
        // `ready` above keeps its old meaning — the LOCAL route — because that is
        // what it has always measured; `speechWorks` is the answer to the question
        // a reader actually has, which depends on the route being taken.
        boolean key = keyPresent.getAsBoolean();
        SttRoute route = SttRoute.of(configured.get(), key);
        out.put("provider", configured.get());
        out.put("language", language.get());
        out.put("route", route == SttRoute.HOSTED ? "hosted" : "local");
        out.put("hosted", Map.of(
                "keyPresent", key,
                "keyEnv", HostedTranscriber.KEY_ENV,
                "model", HostedTranscriber.DEFAULT_MODEL));
        out.put("speechWorks", route == SttRoute.HOSTED ? key : (present && allBins));
        // Card 527: the local route writes along live when whisper-cli and the
        // model are both here, one whisper run over the open window per step.
        // Whether a reader WANTS live text is a browser setting; this says
        // whether the local route can give it, and how often.
        // The same test the socket makes when a recording starts: whisper-cli
        // found and the configured model file there.
        Path liveFile = liveModel.get();
        // Card 528: the program that runs is the one sttRunner resolves to.
        SttRunnerChoice choice = SttRunnerChoice.resolve(runner.get(), locator.apply("whisper-server"),
                locator.apply("whisper-cli"));
        boolean liveReady = choice.ready() && Files.isRegularFile(liveFile);
        Map<String, Object> localLive = new LinkedHashMap<>();
        localLive.put("available", liveReady);
        localLive.put("model", liveFile.getFileName() == null ? MODEL_FILE : liveFile.getFileName().toString());
        localLive.put("chunkMs", SttStreaming.STT_LOCAL_CHUNK_MS);
        localLive.put("windowMs", SttStreaming.STT_LOCAL_WINDOW_MS);
        localLive.put("warmupTimeoutMs", SttStreaming.STT_WARMUP_TIMEOUT_MS);
        boolean server = SpectroConfig.STT_RUNNER_SERVER.equals(choice.running());
        WhisperServerRunner.Status resident = server ? serverStatus.get() : new WhisperServerRunner.Status(false, null);
        Map<String, Object> running = new LinkedHashMap<>();
        running.put("configured", choice.configured());
        running.put("running", choice.running());
        running.put("port", resident.port());
        running.put("up", resident.up());
        running.put("fallback", choice.fallback());
        localLive.put("runner", running);
        out.put("localLive", localLive);
        out.put("runner", choice.configured());
        return out;
    }

    /**
     * The install line for the binary, per platform: a sentence, not a button.
     *
     * @param osName the {@code os.name} property
     * @return the one command that installs it on that platform
     */
    static String hintFor(String osName) {
        return osName.toLowerCase(java.util.Locale.ROOT).contains("mac")
                ? "brew install whisper-cpp"
                : "build whisper.cpp and put build/bin/whisper-cli on the PATH";
    }

    private static long sizeOf(Path file) {
        try {
            return Files.size(file);
        } catch (Exception unreadable) {
            return 0L;
        }
    }

    /** The real HTTP leg, following HuggingFace's CDN redirect. */
    private static InputStream httpFetch(String url) throws Exception {
        HttpClient client = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NORMAL)
                .connectTimeout(Duration.ofSeconds(30))
                .build();
        HttpResponse<InputStream> resp = client.send(
                HttpRequest.newBuilder(URI.create(url)).GET().build(),
                HttpResponse.BodyHandlers.ofInputStream());
        if (resp.statusCode() != 200) {
            throw new IllegalStateException("download HTTP " + resp.statusCode());
        }
        return resp.body();
    }
}
