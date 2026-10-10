package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SettingsWriter;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.run.PinnedPlaybook;
import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;
import dev.spectroscope.server.providers.ProviderRegistry;
import dev.spectroscope.server.providers.ProviderRow;
import dev.spectroscope.server.web.LocalOrigin;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * The playbook routes: the known folders and the pin per workspace, loading a
 * registered folder, and copying a bundled playbook into a folder the owner
 * picked.
 *
 * <p>Only registered folders load, so the wire cannot make the server read an
 * arbitrary directory. Every write wears the fence of
 * {@link dev.spectroscope.server.starter.BundleController#scaffold}: JSON
 * bodies only, a loopback caller, and a loopback or absent Origin; anything
 * else gets a blank 404.
 */
@RestController
public class PlaybookController {

    /** The classpath folder the shipped playbooks live in, one folder per id. */
    static final String BUNDLE_ROOT = "bundled-playbooks";
    static final Pattern BUNDLE_ID = Pattern.compile("[a-z][a-z0-9-]*");

    private final PlaybookFolders folders;
    private final String bundleRoot;
    private final InstallLedger ledger;
    private final Path spectroHome;
    private final Path launchDir;
    private final Path userSettings;
    private final Function<SpectroConfig, List<ProviderRow>> providerRows;

    public PlaybookController() {
        this(PlaybookFolders.inHome(), BUNDLE_ROOT);
    }

    PlaybookController(PlaybookFolders folders, String bundleRoot) {
        this(folders, bundleRoot, InstallLedger.inHome(),
                Path.of(System.getProperty("user.home"), ".spectro"), Path.of(System.getProperty("user.dir")),
                SettingsWriter.userSettingsFile());
    }

    /** Seam for tests: the provider rows the start preview reads, without a request to any provider. */
    PlaybookController(PlaybookFolders folders, String bundleRoot,
                       Function<SpectroConfig, List<ProviderRow>> providerRows) {
        this(folders, bundleRoot, InstallLedger.inHome(),
                Path.of(System.getProperty("user.home"), ".spectro"), Path.of(System.getProperty("user.dir")),
                SettingsWriter.userSettingsFile(), providerRows);
    }

    /**
     * @param ledger      the install ledger, {@code ~/.spectro/playbook-installs.json}
     * @param spectroHome {@code ~/.spectro}, where installed skills and hook scripts live
     * @param launchDir   the launch directory, whose {@code .spectro/skills} is the project skill root
     */
    PlaybookController(PlaybookFolders folders, String bundleRoot, InstallLedger ledger, Path spectroHome,
                       Path launchDir) {
        this(folders, bundleRoot, ledger, spectroHome, launchDir, spectroHome.resolve("settings.json"));
    }

    /**
     * @param userSettings the user settings file the installed hooks are appended to
     */
    PlaybookController(PlaybookFolders folders, String bundleRoot, InstallLedger ledger, Path spectroHome,
                       Path launchDir, Path userSettings) {
        this(folders, bundleRoot, ledger, spectroHome, launchDir, userSettings,
                config -> ProviderRegistry.shared().rows(config));
    }

    /**
     * @param providerRows the provider rows the start preview reads
     */
    PlaybookController(PlaybookFolders folders, String bundleRoot, InstallLedger ledger, Path spectroHome,
                       Path launchDir, Path userSettings, Function<SpectroConfig, List<ProviderRow>> providerRows) {
        this.folders = folders;
        this.bundleRoot = bundleRoot;
        this.ledger = ledger;
        this.spectroHome = spectroHome;
        this.launchDir = launchDir;
        this.userSettings = userSettings;
        this.providerRows = providerRows;
    }

    /** GET /api/playbooks?workspace= : the known folders and the one pinned to the workspace. */
    @GetMapping("/api/playbooks")
    public Map<String, Object> list(@RequestParam(value = "workspace", required = false) String workspace) {
        return state(workspace);
    }

    /** POST /api/playbooks/folders {dir} : registers a folder that holds a playbook.json. */
    @PostMapping(value = "/api/playbooks/folders", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> register(@RequestBody JsonNode body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        String dir = text(body, "dir");
        if (dir.isEmpty()) {
            return badRequest("A folder ('dir') is required.");
        }
        try {
            folders.register(Path.of(dir));
        } catch (IllegalArgumentException refused) {
            return badRequest(refused.getMessage());
        }
        return ResponseEntity.ok(state(text(body, "workspace")));
    }

    /** PUT /api/playbooks/active {workspace, dir} : pins a registered folder to a workspace. */
    @PutMapping(value = "/api/playbooks/active", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> pin(@RequestBody JsonNode body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        String workspace = text(body, "workspace");
        String dir = text(body, "dir");
        if (workspace.isEmpty() || dir.isEmpty()) {
            return badRequest("A workspace and a folder ('workspace', 'dir') are required.");
        }
        try {
            folders.pin(Path.of(workspace), Path.of(dir));
        } catch (IllegalArgumentException refused) {
            return badRequest(refused.getMessage());
        }
        return ResponseEntity.ok(state(workspace));
    }

    /** {@code GET /api/playbooks/load?dir=&workspace=} : a registered folder, loaded. */
    @GetMapping("/api/playbooks/load")
    public ResponseEntity<?> load(@RequestParam("dir") String dir,
                                  @RequestParam(value = "workspace", required = false) String workspace) {
        Path real = registered(dir);
        if (real == null) {
            return badRequest("Not a registered playbook folder: " + dir);
        }
        return ResponseEntity.ok(PlaybookLoader.load(real, workspaceOf(workspace, real), config()));
    }

    /** The largest draft body the check reads. */
    static final int MAX_BODY_BYTES = 1024 * 1024;

    /** {@code GET /api/playbooks/draft?dir=&workspace=} : the editor view of a registered folder's file. */
    @GetMapping("/api/playbooks/draft")
    public ResponseEntity<?> getDraft(@RequestParam("dir") String dir,
                                      @RequestParam(value = "workspace", required = false) String workspace) {
        Path real = registered(dir);
        if (real == null) {
            return badRequest("unknown folder");
        }
        return ResponseEntity.ok(EditorView.ofDisk(real, workspaceOf(workspace, real), config()));
    }

    /**
     * {@code POST /api/playbooks/draft?dir=&workspace=} with the draft as the body : the editor view of the
     * body, checked as a load would check it. Writes nothing. The fence answers first, then the size, then
     * the folder.
     */
    @PostMapping(value = "/api/playbooks/draft", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> postDraft(@RequestParam("dir") String dir,
                                       @RequestParam(value = "workspace", required = false) String workspace,
                                       @RequestBody String body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BODY_BYTES) {
            return ResponseEntity.status(413).body(Map.of("message", "The draft is larger than 1 MB."));
        }
        Path real = registered(dir);
        if (real == null) {
            return badRequest("unknown folder");
        }
        byte[] disk;
        try {
            Path file = real.resolve(PlaybookFolders.PLAYBOOK_FILE);
            disk = Files.isRegularFile(file) && Files.size(file) <= PlaybookLoader.MAX_BYTES
                    ? Files.readAllBytes(file) : new byte[0];
        } catch (IOException unreadable) {
            disk = new byte[0];
        }
        return ResponseEntity.ok(EditorView.of(real, body, disk, workspaceOf(workspace, real), config()));
    }

    /**
     * {@code PUT /api/playbooks/file?dir=&workspace=} with {@code {"baseHash", "playbook"}} : saves the draft as
     * the folder's {@code playbook.json} in the canonical form. The fence answers first, then the size, then
     * the body and the folder. 400 with the findings and nothing written while the draft has findings, 409
     * with the disk hash when the file changed since {@code baseHash}.
     */
    @PutMapping(value = "/api/playbooks/file", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> putFile(@RequestParam("dir") String dir,
                                     @RequestParam(value = "workspace", required = false) String workspace,
                                     @RequestBody String body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        if (body.getBytes(StandardCharsets.UTF_8).length > MAX_BODY_BYTES) {
            return ResponseEntity.status(413).body(Map.of("message", "The draft is larger than 1 MB."));
        }
        JsonNode parsed;
        try {
            parsed = new ObjectMapper().readTree(body);
        } catch (IOException notJson) {
            return badRequest("The body is not JSON.");
        }
        String baseHash = text(parsed, "baseHash");
        JsonNode playbook = parsed == null ? null : parsed.get("playbook");
        if (baseHash.isEmpty() || playbook == null || !playbook.isObject()) {
            return badRequest("A 'baseHash' and a 'playbook' object are required.");
        }
        Path real = registered(dir);
        if (real == null) {
            return badRequest("unknown folder");
        }
        try {
            PlaybookFileWriter.Result result = PlaybookFileWriter.save(real, baseHash, playbook.toString(),
                    workspaceOf(workspace, real), config());
            if (result instanceof PlaybookFileWriter.Written written) {
                return ResponseEntity.ok(written.view());
            }
            if (result instanceof PlaybookFileWriter.Refused refused) {
                return ResponseEntity.badRequest().body(Map.of("findings", refused.findings()));
            }
            return ResponseEntity.status(409).body(Map.of("diskHash", ((PlaybookFileWriter.Changed) result).diskHash()));
        } catch (IllegalArgumentException refused) {
            return badRequest(refused.getMessage());
        } catch (IOException failure) {
            return ResponseEntity.status(500).body(Map.of("message", "Failed to write the playbook: " + failure.getMessage()));
        }
    }

    /**
     * {@code GET /api/playbooks/contents?dir=&workspace=} : what a registered folder brings (skills,
     * commands, hooks, agents, workflows) with source, hash, state and reach, before anything is
     * installed. Behind the same fence as the writes, because the answer carries the full text of
     * the hook scripts. A playbook that does not read answers 200 with its findings and no items.
     */
    @GetMapping("/api/playbooks/contents")
    public ResponseEntity<?> contents(@RequestParam("dir") String dir,
                                      @RequestParam(value = "workspace", required = false) String workspace,
                                      HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Path real = registered(dir);
        if (real == null) {
            return badRequest("Not a registered playbook folder: " + dir);
        }
        String hooksOrigin;
        try {
            Path ws = workspace == null || workspace.isBlank() ? null : Path.of(workspace);
            SpectroConfig.Origin origin = SpectroConfig.loadResolved(SpectroConfig.Overrides.none(), launchDir, ws)
                    .origins().get("hooks");
            hooksOrigin = origin == null ? null : origin.winner();
        } catch (InvalidPathException notAPath) {
            return badRequest("The workspace is not a usable path.");
        }
        PlaybookReader.Read read;
        try {
            read = PlaybookReader.read(Files.readString(real.resolve(PlaybookFolders.PLAYBOOK_FILE), StandardCharsets.UTF_8));
        } catch (IOException unreadable) {
            return ResponseEntity.ok(new PlaybookContents.Preview("", real.toString(), "", List.of(), 0, hooksOrigin,
                    List.of(new Finding(PlaybookFolders.PLAYBOOK_FILE, "unreadable: " + unreadable.getMessage()))));
        }
        if (read.playbook() == null) {
            return ResponseEntity.ok(new PlaybookContents.Preview("", real.toString(), "", List.of(), 0, hooksOrigin,
                    read.findings()));
        }
        try {
            Path projectSkills = SkillLibrary.defaultRoots(launchDir).get(1);
            return ResponseEntity.ok(PlaybookContents.preview(real, read.playbook(), spectroHome, projectSkills,
                    ledger, hooksOrigin));
        } catch (IOException | IllegalStateException failed) {
            return ResponseEntity.status(500).body(Map.of("message", "The contents could not be read: " + failed.getMessage()));
        }
    }

    /**
     * {@code POST /api/playbooks/contents/install {dir, contentsHash, hooks}} : installs what a
     * registered folder brings, bound to the contents hash of the list the owner saw. The hooks go
     * into the user settings only when {@code hooks} is true. Every refusal carries {@code reason},
     * the name of the installer's status, beside {@code message}.
     *
     * @return 200 {@code {installed}}; 400 findings, an unlicensed folder or an unregistered one; 409
     *         changed, already installed or taken, with {@code names}; 413 too large; 500 failed, with
     *         {@code leftover}; 404 for a foreign caller
     */
    @PostMapping(value = "/api/playbooks/contents/install", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> install(@RequestBody JsonNode body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        String dir = text(body, "dir");
        Path real = registered(dir);
        if (real == null) {
            return badRequest("Not a registered playbook folder: " + dir);
        }
        PlaybookReader.Read read = readPlaybook(real);
        if (read.playbook() == null) {
            return refusal(400, PlaybookInstaller.Status.FINDINGS, "The playbook does not read; nothing was written.",
                    Map.of("findings", read.findings().stream().map(f -> f.path() + ": " + f.message()).toList()));
        }
        boolean hooks = body != null && body.path("hooks").asBoolean(false);
        PlaybookInstaller.Result result = installer().install(real, read.playbook(), text(body, "contentsHash"), hooks);
        return switch (result.status()) {
            case INSTALLED -> ResponseEntity.ok(Map.of("installed", result.names()));
            case FINDINGS -> refusal(400, result.status(), result.message(), Map.of("findings", result.names()));
            case UNLICENSED -> refusal(400, result.status(), result.message(), Map.of());
            case CHANGED, ALREADY, TAKEN -> refusal(409, result.status(), result.message(), Map.of("names", result.names()));
            case TOO_LARGE -> refusal(413, result.status(), result.message(), Map.of());
            default -> refusal(500, result.status(), result.message(), Map.of("leftover", result.leftover()));
        };
    }

    /**
     * {@code POST /api/playbooks/contents/remove {dir}} : removes what the install ledger records for
     * the folder's playbook id and keeps every copy edited after the install.
     *
     * @return 200 {@code {removed, kept}}; 400 an unregistered folder or a playbook that does not
     *         read; 404 a foreign caller or a playbook that is not installed; 500 failed, with
     *         {@code leftover}
     */
    @PostMapping(value = "/api/playbooks/contents/remove", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> remove(@RequestBody JsonNode body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        String dir = text(body, "dir");
        Path real = registered(dir);
        if (real == null) {
            return badRequest("Not a registered playbook folder: " + dir);
        }
        PlaybookReader.Read read = readPlaybook(real);
        if (read.playbook() == null) {
            return refusal(400, PlaybookInstaller.Status.FINDINGS, "The playbook does not read, so its id is unknown.",
                    Map.of("findings", read.findings().stream().map(f -> f.path() + ": " + f.message()).toList()));
        }
        List<String> recorded;
        try {
            recorded = ledger.find(read.playbook().id())
                    .map(i -> i.items().stream().map(InstallLedger.Item::name).toList())
                    .orElse(List.of());
        } catch (IllegalStateException unreadable) {
            return refusal(500, PlaybookInstaller.Status.FAILED, unreadable.getMessage(), Map.of("leftover", List.of()));
        }
        PlaybookInstaller.Result result = installer().remove(real, read.playbook());
        return switch (result.status()) {
            case REMOVED -> {
                List<String> removed = new ArrayList<>(recorded);
                result.names().forEach(removed::remove);
                yield ResponseEntity.ok(Map.of("removed", removed, "kept", result.names()));
            }
            case NOT_INSTALLED -> refusal(404, result.status(), result.message(), Map.of());
            default -> refusal(500, result.status(), result.message(), Map.of("leftover", result.leftover()));
        };
    }

    private PlaybookInstaller installer() {
        return new PlaybookInstaller(spectroHome, SkillLibrary.defaultRoots(launchDir).get(1), userSettings, ledger);
    }

    private static PlaybookReader.Read readPlaybook(Path real) {
        try {
            return PlaybookReader.read(Files.readString(real.resolve(PlaybookFolders.PLAYBOOK_FILE), StandardCharsets.UTF_8));
        } catch (IOException unreadable) {
            return new PlaybookReader.Read(null, List.of(new Finding(PlaybookFolders.PLAYBOOK_FILE,
                    "unreadable: " + unreadable.getMessage())));
        }
    }

    private static ResponseEntity<Map<String, Object>> refusal(int status, PlaybookInstaller.Status reason, String message,
                                                               Map<String, Object> extra) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("reason", reason.name());
        out.put("message", message);
        out.putAll(extra);
        return ResponseEntity.status(status).body(out);
    }

    /**
     * {@code GET /api/playbooks/start-preview?dir=&workspace=} : the
     * confirmation of a run (card 482). Fenced like every write, because the
     * hash it returns is what a start frame must repeat. Provider rows come
     * from the registry without a request, and a browser can answer a
     * question, so the preview assumes someone is there to ask.
     *
     * @param dir       a registered playbook folder
     * @param workspace the session's working folder, for installed skills
     * @param request   the servlet request, for the local fence
     * @return 200 with the preview; 400 for a folder that is not registered or cannot be pinned; 404 for a foreign caller
     */
    @GetMapping("/api/playbooks/start-preview")
    public ResponseEntity<PlaybookStartPreview> startPreview(@RequestParam("dir") String dir,
                                                             @RequestParam("workspace") String workspace,
                                                             HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Path real = registered(dir);
        if (real == null || workspace == null || workspace.isBlank()) {
            return ResponseEntity.badRequest().build();
        }
        SpectroConfig config = SpectroConfig.load(SpectroConfig.Overrides.none());
        Path ws = Path.of(workspace);
        PlaybookLoader.Loaded loaded = PlaybookLoader.load(real, ws, config);
        PinnedPlaybook pinned = null;
        if (loaded.playbook() != null && loaded.findings().isEmpty()) {
            SkillLibrary skills = SkillLibrary.load(SkillLibrary.defaultRoots(ws));
            try {
                pinned = PinnedPlaybook.pin(real, loaded.playbook(),
                        name -> skills.find(name).map(Skill::body).orElse(null));
            } catch (IOException | RuntimeException unreadable) {
                return ResponseEntity.badRequest().build();
            }
        }
        Map<String, ProviderRow> rows = new LinkedHashMap<>();
        providerRows.apply(config).forEach(r -> rows.put(r.id(), r));
        return ResponseEntity.ok(PlaybookStartPreview.of(loaded, pinned, rows::get, true));
    }

    /**
     * POST /api/playbooks/bundled/{id}/copy {dir} : writes a shipped playbook
     * into the folder and registers it. Like the scaffold, it resolves every
     * target first, refuses a path outside the folder, and writes nothing when
     * any target exists (409 with the paths).
     */
    @PostMapping(value = "/api/playbooks/bundled/{id}/copy", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> copy(@PathVariable String id, @RequestBody JsonNode body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Map<String, Resource> files = BUNDLE_ID.matcher(id).matches() ? bundled(id) : Map.of();
        if (files.isEmpty()) {
            return ResponseEntity.status(404).body(Map.of("message", "Unknown bundled playbook: " + id));
        }
        String dirText = text(body, "dir");
        if (dirText.isEmpty()) {
            return badRequest("A target folder ('dir') is required.");
        }
        Path dir = Path.of(dirText);
        if (!Files.isDirectory(dir)) {
            return badRequest("Not a folder: " + dirText);
        }
        Path root;
        try {
            root = dir.toRealPath();
        } catch (IOException e) {
            return badRequest("Not a folder: " + dirText);
        }

        Map<Path, Resource> targets = new LinkedHashMap<>();
        List<String> conflicts = new ArrayList<>();
        for (Map.Entry<String, Resource> entry : files.entrySet()) {
            Path target = root.resolve(entry.getKey()).normalize();
            if (!target.startsWith(root)) {
                return badRequest("Refusing a path outside the folder: " + entry.getKey());
            }
            if (Files.exists(target)) {
                conflicts.add(entry.getKey());
            }
            targets.put(target, entry.getValue());
        }
        if (!conflicts.isEmpty()) {
            return ResponseEntity.status(409).body(Map.of(
                    "message", "Some files already exist in the folder; nothing was written.",
                    "conflicts", conflicts));
        }

        List<String> written = new ArrayList<>();
        try {
            for (Map.Entry<Path, Resource> entry : targets.entrySet()) {
                Files.createDirectories(entry.getKey().getParent());
                try (var in = entry.getValue().getInputStream()) {
                    Files.write(entry.getKey(), in.readAllBytes());
                }
                written.add(root.relativize(entry.getKey()).toString());
            }
        } catch (IOException failure) {
            return ResponseEntity.status(500).body(Map.of(
                    "message", "Failed to write the playbook: " + failure.getMessage(), "written", written));
        }
        try {
            folders.register(root);
        } catch (IllegalArgumentException refused) {
            return ResponseEntity.status(500).body(Map.of(
                    "message", "Copied, but the folder could not be registered: " + refused.getMessage(),
                    "written", written));
        }
        return ResponseEntity.ok(Map.of("dir", root.toString(), "written", written));
    }

    /** The shipped playbook {@code id} as path below its folder to resource; empty when there is none. */
    Map<String, Resource> bundled(String id) {
        String anchor = bundleRoot + "/" + id + "/";
        Map<String, Resource> files = new LinkedHashMap<>();
        Resource[] found;
        try {
            found = new PathMatchingResourcePatternResolver().getResources("classpath*:" + anchor + "**");
        } catch (IOException unreadable) {
            return Map.of();
        }
        for (Resource resource : found) {
            String url;
            try {
                url = String.valueOf(resource.getURL());
            } catch (IOException unreadable) {
                continue;
            }
            if (url.endsWith("/") || !resource.isReadable()) {
                continue; // a directory comes back as a non-readable resource
            }
            int at = url.lastIndexOf(anchor);
            if (at < 0) {
                continue; // never guessed, only skipped
            }
            String rel = url.substring(at + anchor.length());
            if (!rel.isEmpty()) {
                files.put(rel, resource);
            }
        }
        return files;
    }

    private Map<String, Object> state(String workspace) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("folders", folders.read().folders());
        Path active = workspace == null || workspace.isBlank() ? null : folders.activeFor(Path.of(workspace));
        out.put("active", active == null ? null : active.toString());
        return out;
    }

    /** The real path of {@code dir} when it is a registered folder, else null. */
    private Path registered(String dir) {
        if (dir == null || dir.isBlank()) {
            return null;
        }
        try {
            Path real = Path.of(dir).toRealPath();
            return folders.read().folders().contains(real.toString()) ? real : null;
        } catch (IOException | RuntimeException missing) {
            return null;
        }
    }

    private static Path workspaceOf(String workspace, Path folder) {
        return workspace == null || workspace.isBlank() ? folder : Path.of(workspace);
    }

    private static SpectroConfig config() {
        return SpectroConfig.load(SpectroConfig.Overrides.none());
    }

    private static boolean fenced(HttpServletRequest request) {
        return LocalOrigin.isLocalOrigin(request) && LocalOrigin.originIsLoopbackOrAbsent(request);
    }

    private static String text(JsonNode body, String field) {
        return body == null ? "" : body.path(field).asText("").strip();
    }

    private static ResponseEntity<Map<String, String>> badRequest(String message) {
        return ResponseEntity.badRequest().body(Map.of("message", message));
    }
}
