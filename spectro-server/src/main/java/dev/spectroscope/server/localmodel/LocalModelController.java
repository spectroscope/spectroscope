package dev.spectroscope.server.localmodel;

import dev.spectroscope.core.local.LocalCatalog;
import dev.spectroscope.core.local.LocalModel;
import dev.spectroscope.core.local.LocalPreflight;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The built-in provider's model endpoints, behind the picker's chooser dialog:
 * {@code GET /api/local-model/catalog} (every offered model, its download state
 * and whether this machine can hold it), {@code GET /api/local-model/status}
 * (polled for progress) and {@code POST /api/local-model/download} (starts the
 * fetch). Which models exist, their urls and their sha256 pins all come from
 * {@link LocalCatalog} — nothing is pinned here any more. Writes are
 * loopback-and-Host fenced like every other write; the READS wear the Host
 * fence too (card 107): the catalogue reports this machine's RAM, free disk
 * and which multi-GB models are on disk — a hardware fingerprint a
 * DNS-rebinding page (attacker Host resolved to 127.0.0.1) must not read,
 * for the same reason the fleet roster refuses it.
 *
 * <p>No {@code @CrossOrigin} — same-origin only, matching the settings/probe
 * controllers.</p>
 */
@RestController
public class LocalModelController {

    private final Map<String, LocalModelDownload> downloads;

    /** Spring wiring — the real user models dir + an HTTP fetcher per model. */
    public LocalModelController() {
        this(LocalModel.userModelsDir(), LocalModelController::httpFetch);
    }

    /** Seam constructor for tests: same wiring, injectable dir and fetcher. */
    LocalModelController(Path modelsDir, LocalModelDownload.Fetcher fetcher) {
        Map<String, LocalModelDownload> perModel = new LinkedHashMap<>();
        for (LocalCatalog.Model m : LocalCatalog.bundled().models()) {
            perModel.put(m.id(), new LocalModelDownload(
                    modelsDir, m.file(), m.sha256(), m.sizeBytes(), fetcher, m.url()));
        }
        this.downloads = perModel;
    }

    /**
     * The chooser's one fetch: machine numbers once, then every model with its
     * catalogue facts, download state and preflight verdict.
     *
     * @param request the servlet request — must be a local origin (the machine
     *                numbers are a fingerprint, see the class comment)
     * @return the catalogue as the dialog renders it, or 404 for a non-local
     *         caller or a rebound Host
     */
    @GetMapping("/api/local-model/catalog")
    public ResponseEntity<Map<String, Object>> catalog(HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)) {
            return ResponseEntity.notFound().build();
        }
        LocalCatalog catalogue = LocalCatalog.bundled();
        long ram = LocalPreflight.totalMemoryBytes();
        long disk = LocalPreflight.usableSpaceBytes(LocalModel.userModelsDir());

        Map<String, Object> machine = new LinkedHashMap<>();
        machine.put("ramTotalBytes", ram);
        machine.put("diskFreeBytes", disk);
        // Whether a llama-server exists for this install at all. The desktop kit
        // bundles one; the bare jar and the CLI do not. The dialog says so up
        // front rather than letting a missing binary surface as a failed spawn
        // after a multi-gigabyte download.
        machine.put("binaryPresent", ServerLocalRuntime.binaryAvailable());

        List<Map<String, Object>> models = new ArrayList<>();
        for (LocalCatalog.Model m : catalogue.models()) {
            LocalPreflight.Verdict verdict = LocalPreflight.check(m, ram, disk);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", m.id());
            row.put("label", m.label());
            row.put("sizeBytes", m.sizeBytes());
            row.put("minRamBytes", m.minRamBytes());
            row.put("contextTokens", m.contextTokens());
            row.put("nativeTools", m.nativeTools());
            row.put("reasoning", m.reasoning());
            row.put("licence", m.licence());
            row.put("licenceUrl", m.licenceUrl());
            row.put("sourceUrl", m.sourceUrl());
            if (m.licenceCaveatKey() != null) {
                row.put("licenceCaveat", true);
            }
            Map<String, Object> status = downloads.get(m.id()).status();
            row.put("state", status.get("state"));
            row.put("bytes", status.get("bytes"));
            Map<String, Object> preflight = new LinkedHashMap<>();
            preflight.put("ok", verdict.ok());
            preflight.put("tight", verdict.tight());
            preflight.put("known", verdict.known());
            preflight.put("ramOk", verdict.ramOk());
            preflight.put("diskOk", verdict.diskOk());
            row.put("preflight", preflight);
            models.add(row);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("defaultId", catalogue.defaultId());
        out.put("machine", machine);
        out.put("models", models);
        return ResponseEntity.ok(out);
    }

    /**
     * Current download/presence state of one model — polled by the dialog for
     * its progress bar.
     *
     * @param model   the catalogue id; absent means the default model, so the
     *                pre-catalogue client keeps working
     * @param request the servlet request — must be a local origin, like the
     *                catalogue (which model sits on disk is part of the same
     *                fingerprint)
     * @return 200 with the state, or 404 for a non-local caller, a rebound
     *         Host or an id this build does not offer — never a silent default
     *         that would report the wrong file
     */
    @GetMapping("/api/local-model/status")
    public ResponseEntity<Map<String, Object>> status(
            @RequestParam(name = "model", required = false) String model,
            HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)) {
            return ResponseEntity.notFound().build();
        }
        LocalModelDownload download = downloadFor(model);
        if (download == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(download.status());
    }

    /**
     * Start one model's download (idempotent per model; two different models
     * may download concurrently). Fenced like every write: 404 for a non-local
     * caller, a rebound Host or a cross-site Origin.
     *
     * @param model   the catalogue id; absent means the default model
     * @param request the servlet request, for the local-origin write fence
     * @return 200 with the current status, or 404 when the fence or the id refuses
     */
    @PostMapping("/api/local-model/download")
    public ResponseEntity<Map<String, Object>> startDownload(
            @RequestParam(name = "model", required = false) String model,
            HttpServletRequest request) {
        if (!LocalOrigin.isLocalOrigin(request)
                || !LocalOrigin.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }
        LocalModelDownload download = downloadFor(model);
        if (download == null) {
            return ResponseEntity.notFound().build();
        }
        download.start();
        return ResponseEntity.ok(download.status());
    }

    /** @return the download for the id, the default's for null/blank, or null for unknown */
    private LocalModelDownload downloadFor(String model) {
        if (model == null || model.isBlank()) {
            return downloads.get(LocalCatalog.bundled().defaultId());
        }
        return downloads.get(model);
    }

    /** The real HTTP leg: GET the catalogue url, following HuggingFace's CDN redirect. */
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
