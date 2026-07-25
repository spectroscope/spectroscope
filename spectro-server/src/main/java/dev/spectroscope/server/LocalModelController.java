package dev.spectroscope.server;

import dev.spectroscope.core.local.LocalModel;
import jakarta.servlet.http.HttpServletRequest;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The built-in model's download endpoints, behind the picker's download modal:
 * {@code GET /api/local-model/status} (polled for progress) and {@code POST
 * /api/local-model/download} (starts the fetch). The model, URL and sha256 are
 * pinned here; the write is loopback-and-Host fenced like every other write.
 *
 * <p>No {@code @CrossOrigin} — same-origin only, matching the settings/probe
 * controllers.</p>
 */
@RestController
public class LocalModelController {

    /** The pinned source: mradermacher's Q4_K_M GGUF, sha256 verified after the
     *  stream. Saved under {@link LocalModel#FILE}. ~1.93 GB. */
    private static final String URL =
            "https://huggingface.co/mradermacher/VibeThinker-3B-GGUF/resolve/main/VibeThinker-3B.Q4_K_M.gguf";
    private static final String SHA256 =
            "6b2d4e6983180dd2d02396686fb0bbeaecad2a47193ec78e011254ee6f7207cc";
    private static final long SIZE = 1_929_903_232L;

    private final LocalModelDownload download;

    /** Spring wiring — the real user models dir + an HTTP fetcher (follows the HF redirect). */
    public LocalModelController() {
        this(new LocalModelDownload(LocalModel.userModelsDir(), LocalModel.FILE, SHA256, SIZE,
                LocalModelController::httpFetch, URL));
    }

    /** Seam constructor for tests. */
    LocalModelController(LocalModelDownload download) {
        this.download = download;
    }

    /** Current download/presence state — polled by the modal for its progress bar. */
    @GetMapping("/api/local-model/status")
    public Map<String, Object> status() {
        return download.status();
    }

    /**
     * Start the download (idempotent). Fenced like every write: 404 for a
     * non-local caller, a rebound Host or a cross-site Origin.
     *
     * @param request the servlet request, for the local-origin write fence
     * @return 200 with the current status, or 404 when the fence refuses
     */
    @PostMapping("/api/local-model/download")
    public ResponseEntity<Map<String, Object>> startDownload(HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)
                || !FleetController.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        download.start();
        return ResponseEntity.ok(download.status());
    }

    /** The real HTTP leg: GET the pinned URL, following HuggingFace's CDN redirect. */
    private static java.io.InputStream httpFetch(String url) throws Exception {
        HttpClient client = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NORMAL)
                .connectTimeout(Duration.ofSeconds(30))
                .build();
        HttpResponse<java.io.InputStream> resp = client.send(
                HttpRequest.newBuilder(URI.create(url)).GET().build(),
                HttpResponse.BodyHandlers.ofInputStream());
        if (resp.statusCode() != 200) {
            throw new IllegalStateException("download HTTP " + resp.statusCode());
        }
        return resp.body();
    }
}
