package dev.spectroscope.server;

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
    private final String path;
    private final LocalModelDownload download;

    public SttController() {
        this(Path.of(System.getProperty("user.home"), ".spectro", "models"),
                System.getenv("PATH"), SttController::httpFetch);
    }

    /** Seam for tests: a models dir, a PATH to search, and the HTTP leg. */
    SttController(Path modelsDir, String path, LocalModelDownload.Fetcher fetcher) {
        this.modelsDir = modelsDir;
        this.path = path == null ? "" : path;
        this.download = new LocalModelDownload(modelsDir, MODEL_FILE, MODEL_SHA256, MODEL_BYTES,
                fetcher, MODEL_URL);
    }

    /**
     * Where an executable really sits, searched the way a shell searches.
     *
     * <p>Visible for tests, and pure on purpose: the honest answer to "can this
     * machine transcribe" is three file checks, and a probe that guessed from
     * the operating system rather than looking would be the invention this whole
     * card exists to remove.</p>
     *
     * @param name the executable
     * @param path the PATH to search, colon-separated
     * @return the path it was found at, or null
     */
    static String onPath(String name, String path) {
        for (String dir : path.split(":")) {
            if (dir.isBlank()) {
                continue;
            }
            Path candidate = Path.of(dir, name);
            if (Files.isExecutable(candidate)) {
                return candidate.toString();
            }
        }
        return null;
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
        if (!FleetController.isLocalOrigin(request)
                || !FleetController.originIsLoopbackOrAbsent(request)) {
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
        if (!FleetController.isLocalOrigin(request)
                || !FleetController.originIsLoopbackOrAbsent(request)) {
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
            String at = onPath(name, path);
            Map<String, Object> one = new LinkedHashMap<>();
            one.put("found", at != null);
            one.put("path", at);
            bins.put(name, one);
            allBins &= at != null;
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
        return out;
    }

    /** The install line for the binary, per platform — a sentence, not a button. */
    private static String hintFor(String osName) {
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
