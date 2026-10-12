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
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

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
     * The largest body {@code PUT /api/playbooks/write} reads: a text of 1 MB in JSON, where an escaped
     * control character takes six bytes.
     */
    public static final int MAX_WRITE_BODY_BYTES = 6 * 1024 * 1024 + 64 * 1024;

    /**
     * {@code GET /api/playbooks/tree?dir=} : the files of a registered folder in the shape the Files
     * panel reads, to the loader's depth and file count (card 522). A link or a file that is not
     * regular is a finding, never an entry.
     *
     * @return 200 with the tree; 404 with no body for a foreign caller or a folder that is not registered
     */
    @GetMapping("/api/playbooks/tree")
    public ResponseEntity<?> tree(@RequestParam("dir") String dir, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Path real = registered(dir);
        if (real == null) {
            return ResponseEntity.notFound().build();
        }
        try {
            return ResponseEntity.ok(PlaybookFiles.tree(real));
        } catch (IOException failure) {
            return ResponseEntity.status(500).body(Map.of("message", "The folder could not be listed."));
        }
    }

    /**
     * {@code GET /api/playbooks/read?dir=&path=} : one text file of a registered folder with its sha256.
     *
     * @return 200 {@code {path, text, sha256, size}}; 413 above 1 MB; 415 not UTF-8 text; 404 with no
     *         body for a foreign caller, a folder that is not registered, or a path that is absolute,
     *         holds {@code ..}, meets a link or names no file inside the folder
     */
    @GetMapping("/api/playbooks/read")
    public ResponseEntity<?> readFile(@RequestParam("dir") String dir, @RequestParam("path") String path,
                                      HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Path real = registered(dir);
        if (real == null) {
            return ResponseEntity.notFound().build();
        }
        try {
            return answer(PlaybookFiles.read(real, path));
        } catch (IOException failure) {
            return ResponseEntity.status(500).body(Map.of("message", "The file could not be read."));
        }
    }

    /**
     * {@code PUT /api/playbooks/write {dir, path, text, baseHash}} : writes one text file of a
     * registered folder through a temp file and an atomic move. {@code baseHash} is the sha256 the
     * text was made from, or {@code ""} for a new file.
     *
     * @return 200 {@code {path, sha256, size}}; 400 a missing field, {@code playbook.json}, a folder,
     *         a path deeper than the loader reads or a name outside the segment rule; 409 with
     *         {@code diskHash} when the file is not the one the text was made from; 413 a text above
     *         1 MB or a folder that would pass 200 files or 24 MB; 415 a text with a NUL; 404 with no
     *         body as for the read
     */
    @PutMapping(value = "/api/playbooks/write", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> writeFile(@RequestBody String body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        if (body.getBytes(StandardCharsets.UTF_8).length > MAX_WRITE_BODY_BYTES) {
            return ResponseEntity.status(413).body(Map.of("reason", "too-large",
                    "message", "The file is larger than 1 MB. The editor writes text files up to 1 MB."));
        }
        JsonNode parsed;
        try {
            parsed = new ObjectMapper().readTree(body);
        } catch (IOException notJson) {
            return ResponseEntity.badRequest().body(Map.of("reason", "bad-request", "message", "The body is not JSON."));
        }
        if (parsed == null || !parsed.path("dir").isTextual() || !parsed.path("path").isTextual()
                || !parsed.path("text").isTextual() || !parsed.path("baseHash").isTextual()) {
            return ResponseEntity.badRequest().body(Map.of("reason", "bad-request",
                    "message", "A 'dir', a 'path', a 'text' and a 'baseHash' are required."));
        }
        Path real = registered(parsed.get("dir").asText());
        if (real == null) {
            return ResponseEntity.notFound().build();
        }
        try {
            return answer(PlaybookFiles.write(real, parsed.get("path").asText(), parsed.get("text").asText(),
                    parsed.get("baseHash").asText()));
        } catch (IOException failure) {
            return ResponseEntity.status(500).body(Map.of("message", "The file could not be written."));
        }
    }

    /**
     * {@code DELETE /api/playbooks/file-at?dir=&path=} : removes one text file of a registered folder,
     * never a folder and never {@code playbook.json}, {@code LICENSE} or {@code PROVENANCE.md} at the root.
     *
     * @return 200 {@code {path, deleted}}; 400 a folder or a protected file; 413 or 415 a file that is
     *         not a text file the editor opens; 404 with no body as for the read
     */
    @DeleteMapping("/api/playbooks/file-at")
    public ResponseEntity<?> deleteFile(@RequestParam("dir") String dir, @RequestParam("path") String path,
                                        HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Path real = registered(dir);
        if (real == null) {
            return ResponseEntity.notFound().build();
        }
        try {
            return answer(PlaybookFiles.delete(real, path));
        } catch (IOException failure) {
            return ResponseEntity.status(500).body(Map.of("message", "The file could not be removed."));
        }
    }

    /**
     * The largest body {@code POST /api/playbooks/import} reads: a bundle of 24 MB in JSON, twice over,
     * for base64 and escaped text. The handler counts the decoded bytes against 24 MB.
     */
    public static final int MAX_IMPORT_BODY_BYTES = 48 * 1024 * 1024 + 64 * 1024;

    /**
     * {@code GET /api/playbooks/export?dir=} : the registered folder as one ZIP named
     * {@code <id>.playbook.zip} (card 524). Every file the walk lists sits under one folder named
     * after the id, in the walk's order and with one fixed entry time, so the same folder gives the
     * same bytes. Finder's {@code .DS_Store} is left out.
     *
     * @return 200 with the ZIP; 409 with {@code findings} for a link, a file that is not regular, a
     *         name or a binary file the import refuses, the caps, or a playbook that does not load
     *         cleanly; 422 {@code token} with {@code findings} when a hook command of
     *         {@code hooks/hooks.json} carries a credential shape of the wire redaction, naming the
     *         line and the rule and never the value (card 538); 404 with no body for a foreign caller
     *         or a folder that is not registered
     */
    @GetMapping("/api/playbooks/export")
    public ResponseEntity<StreamingResponseBody> exportBundle(@RequestParam("dir") String dir,
                                                              HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Path real = registered(dir);
        if (real == null) {
            return ResponseEntity.notFound().build();
        }
        PlaybookBundle.Export export;
        try {
            export = PlaybookBundle.prepare(real);
        } catch (IOException failure) {
            return json(500, Map.of("reason", "failed", "message", "The folder could not be read."));
        }
        if (export instanceof PlaybookBundle.NotReady notReady) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("reason", "refused");
            out.put("message", "This folder cannot be exported: the import would refuse it.");
            out.put("findings", notReady.findings());
            return json(409, out);
        }
        if (export instanceof PlaybookBundle.Credential credential) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("reason", "token");
            out.put("message", PlaybookBundle.credentialSentence(credential.findings(), "Nothing was exported."));
            out.put("findings", credential.findings());
            return json(422, out);
        }
        PlaybookBundle.Ready ready = (PlaybookBundle.Ready) export;
        // A zip is never rendered, and nosniff keeps a legacy sniffer from promoting it. The id in
        // the filename passed the id shape, which carries no quote, CR or LF.
        return ResponseEntity.ok()
                .contentType(new MediaType("application", "zip"))
                .header("X-Content-Type-Options", "nosniff")
                .header("Content-Disposition", "attachment; filename=\"" + ready.id() + ".playbook.zip\"")
                .body(out -> PlaybookBundle.write(ready, out));
    }

    /**
     * A JSON answer on a route whose body is a stream: Spring writes a {@link StreamingResponseBody}
     * whatever the status, so a refusal is serialized here.
     */
    private static ResponseEntity<StreamingResponseBody> json(int status, Map<String, ?> body) {
        byte[] bytes;
        try {
            bytes = new ObjectMapper().writeValueAsBytes(body);
        } catch (IOException unwritable) {
            bytes = "{}".getBytes(StandardCharsets.UTF_8);
        }
        byte[] payload = bytes;
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_JSON).body(out -> out.write(payload));
    }

    /**
     * {@code POST /api/playbooks/import {dir, workspace?, entries:[{path, text}|{path, base64}]}} :
     * writes a bundle the browser read into the empty folder {@code dir}, registers it and answers
     * the loaded view (card 524). Every path and size is checked before a byte is written; the files
     * go to a staged folder beside the target, which is checked as the loader checks a folder and
     * then moved onto the target in one move. Nothing is installed.
     *
     * @return 200 with the loaded view; 400 a body, path or entry that is not the shape, two entries
     *         for one file, a binary file outside {@code docs/}, no {@code playbook.json}; 409 a target
     *         that is not empty; 413 more than 200 files, more than 24 MB, a binary file over 2 MB;
     *         415 a text entry with a NUL; 422 with {@code findings} for a playbook that does not load
     *         cleanly, or {@code token} for a hook command with a credential shape (card 538); 404 with
     *         no body for a foreign caller
     */
    @PostMapping(value = "/api/playbooks/import", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> importBundle(@RequestBody String body, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        if (body.length() > MAX_IMPORT_BODY_BYTES) {
            return ResponseEntity.status(413).body(Map.of("reason", "too-large",
                    "message", "The bundle holds more than 24 MB."));
        }
        JsonNode parsed;
        try {
            parsed = new ObjectMapper().readTree(body);
        } catch (IOException notJson) {
            return ResponseEntity.badRequest().body(Map.of("reason", "bad-request", "message", "The body is not JSON."));
        }
        if (parsed == null || !parsed.isObject()) {
            return ResponseEntity.badRequest().body(Map.of("reason", "bad-request", "message", "The body is not JSON."));
        }
        PlaybookBundle.Outcome outcome;
        try {
            outcome = PlaybookBundle.importInto(folders, text(parsed, "dir"), parsed.get("entries"));
        } catch (IOException | RuntimeException failure) {
            return ResponseEntity.status(500).body(Map.of("reason", "failed",
                    "message", "The bundle could not be written: " + failure.getClass().getSimpleName()));
        }
        if (outcome.written() == null) {
            return ResponseEntity.status(outcome.status()).body(outcome.body());
        }
        return ResponseEntity.ok(PlaybookLoader.load(outcome.written(),
                workspaceOf(text(parsed, "workspace"), outcome.written()), config()));
    }

    /**
     * {@code GET /api/playbooks/import-sources?dir=&workspace=} : what can be put into a registered
     * folder (card 523): the installed skills by root label and pack, the catalogue skills by id and
     * the hooks of the user settings, each hook with {@code left} set when the import leaves it out.
     * No path of the machine is echoed: a root is a label, and the home folder and the project folder
     * (the workspace, else the launch folder) in a hook command are written as {@code ~} and
     * {@code {project}}.
     *
     * @return 200 with the sources; 404 with no body for a foreign caller or a folder that is not registered
     */
    @GetMapping("/api/playbooks/import-sources")
    public ResponseEntity<?> importSources(@RequestParam("dir") String dir,
                                           @RequestParam(value = "workspace", required = false) String workspace,
                                           HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Path real = registered(dir);
        if (real == null) {
            return ResponseEntity.notFound().build();
        }
        try {
            return ResponseEntity.ok(imports(workspace).sources(real));
        } catch (IOException failure) {
            return ResponseEntity.status(500).body(Map.of("message", "The sources could not be listed."));
        }
    }

    /**
     * {@code POST /api/playbooks/import-skills {dir, baseHash?, items:[{source, root?, pack?, name?}]}} :
     * copies installed or catalogue skills into the folder's {@code skills/<pack>/<name>} and lists the
     * pack in {@code contents.skills}. Sources are looked up by label, pack and name, never resolved
     * from the request.
     *
     * @return 200 {@code {imported, already, sha256, contents}}; 400 an unknown source, a link in a
     *         source, a pack named like the playbook id, a playbook that does not read cleanly; 409 a
     *         target with other content or a stale {@code baseHash}; 413 the caps; 404 with no body
     *         for a foreign caller or a folder that is not registered
     */
    @PostMapping(value = "/api/playbooks/import-skills", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> importSkills(@RequestBody JsonNode body, HttpServletRequest request) {
        return imported(body, request, PlaybookImports::importSkills);
    }

    /**
     * {@code POST /api/playbooks/import-hooks {dir, replace?, baseHash?, workspace?}} : writes the hooks
     * of the user settings into {@code hooks/hooks.json}, copies the scripts their commands name from
     * the home into {@code hooks/}, writes the project folder (the workspace, else the launch folder)
     * as {@code {project}}, leaves out a hook that names a dot folder of the home (card 538), and lists
     * the file in {@code contents.hooks}. The settings are only read.
     *
     * @return 200 {@code {hooks, scripts, left, sha256, contents}}; 400 no hooks, or
     *         {@code all-left-out} with {@code left}; 409 an existing {@code hooks/hooks.json} without
     *         {@code replace}; 404 as for the other routes
     */
    @PostMapping(value = "/api/playbooks/import-hooks", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> importHooks(@RequestBody JsonNode body, HttpServletRequest request) {
        return imported(body, request, PlaybookImports::importHooks);
    }

    /**
     * {@code POST /api/playbooks/new-agent {dir, name, type, skill?, description?}} : writes
     * {@code agents/<name>.md} from the template and lists it in {@code contents.agents}.
     *
     * @return 200 {@code {path, sha256, contents}}; 409 a name outside the segment rule or one that
     *         exists; 400 an unknown type or a skill name that is not one token; 404 as for the other routes
     */
    @PostMapping(value = "/api/playbooks/new-agent", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> newAgent(@RequestBody JsonNode body, HttpServletRequest request) {
        return imported(body, request, PlaybookImports::newAgent);
    }

    /**
     * {@code POST /api/playbooks/new-command {dir, name}} : writes {@code commands/<name>.md} from the
     * template and lists it in {@code contents.commands}.
     *
     * @return 200 {@code {path, sha256, contents}}; 409 a name outside the segment rule or one that
     *         exists; 404 as for the other routes
     */
    @PostMapping(value = "/api/playbooks/new-command", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> newCommand(@RequestBody JsonNode body, HttpServletRequest request) {
        return imported(body, request, PlaybookImports::newCommand);
    }

    /**
     * {@code POST /api/playbooks/remove-content {dir, kind, path}} : takes the entry out of
     * {@code contents} and removes the files under its path, never a file outside the kind's folder
     * and never {@code playbook.json}.
     *
     * @return 200 {@code {removed, sha256, contents}}; 400 a kind, a path or a link this route does
     *         not remove; 404 as for the other routes
     */
    @PostMapping(value = "/api/playbooks/remove-content", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> removeContent(@RequestBody JsonNode body, HttpServletRequest request) {
        return imported(body, request, PlaybookImports::removeContent);
    }

    /**
     * {@code GET /api/playbooks/plugin-sources?dir=} : the Claude Code plugins of this home (card 526),
     * from the plugin cache and the local plugins of each marketplace under {@code ~/.claude/plugins},
     * each by its root label, marketplace, name and version, with the count of each kind it carries,
     * whether it carries MCP servers and whether it has a licence. No path of the machine is echoed. A
     * home without those folders answers an empty list.
     *
     * @return 200 {@code {plugins:[...]}}; 404 with no body for a foreign caller or a folder that is
     *         not registered
     */
    @GetMapping("/api/playbooks/plugin-sources")
    public ResponseEntity<?> pluginSources(@RequestParam("dir") String dir, HttpServletRequest request) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Path real = registered(dir);
        if (real == null) {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok(imports(null).pluginSources());
    }

    /**
     * {@code POST /api/playbooks/import-plugin {dir, baseHash?, plugin:{root?, marketplace, name, version},
     * kinds:[skills|agents|commands|hooks]}} : copies the chosen kinds of a listed plugin into the
     * folder (card 526). Skills land in {@code skills/<plugin>/} as one pack, agents in
     * {@code agents/<name>.md} with the four fields a playbook agent has, commands in
     * {@code commands/<name>.md}, PreToolUse and PostToolUse hooks in {@code hooks/hooks.json} with
     * the scripts they run. MCP servers and {@code .mcp.json} are never copied. Nothing is installed:
     * hooks and agents reach the harness only through the install confirmation.
     *
     * @return 200 {@code {imported, already, dropped, droppedHooks, notCopied, sha256, contents}}; 400
     *         a request without plugin or kinds, an unknown kind, an unlicensed plugin, a link, a name
     *         or a depth the folder does not take; 409 a target with other content; 413 the caps; 404
     *         with no body for a plugin that is not listed, a foreign caller or a folder that is not
     *         registered
     */
    @PostMapping(value = "/api/playbooks/import-plugin", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<?> importPlugin(@RequestBody JsonNode body, HttpServletRequest request) {
        return imported(body, request, PlaybookImports::importPlugin);
    }

    /** One of the card 523 routes: the fence, the registered folder, then the work. */
    private ResponseEntity<?> imported(JsonNode body, HttpServletRequest request, ImportRoute route) {
        if (!fenced(request)) {
            return ResponseEntity.notFound().build();
        }
        Path real = registered(text(body, "dir"));
        if (real == null) {
            return ResponseEntity.notFound().build();
        }
        try {
            return answer(route.run(imports(text(body, "workspace")), real, body));
        } catch (IOException | RuntimeException failure) {
            return ResponseEntity.status(500).body(Map.of("reason", "failed",
                    "message", "The playbook folder could not be changed: " + failure.getClass().getSimpleName()));
        }
    }

    @FunctionalInterface
    private interface ImportRoute {
        PlaybookFiles.Answer run(PlaybookImports imports, Path root, JsonNode body) throws IOException;
    }

    private PlaybookImports imports(String workspace) {
        return new PlaybookImports(spectroHome, SkillLibrary.defaultRoots(launchDir).get(1), projectOf(workspace),
                userSettings);
    }

    /**
     * The folder a hook's {@code {project}} stands for (card 538): the workspace the request names when
     * it is an absolute folder that exists, else the launch folder.
     */
    private Path projectOf(String workspace) {
        if (workspace != null && !workspace.isBlank()) {
            try {
                Path named = Path.of(workspace);
                if (named.isAbsolute() && Files.isDirectory(named)) {
                    return named.normalize();
                }
            } catch (InvalidPathException unusable) {
                // the launch folder answers instead
            }
        }
        return launchDir.toAbsolutePath().normalize();
    }

    private static ResponseEntity<?> answer(PlaybookFiles.Answer answer) {
        if (answer instanceof PlaybookFiles.Done done) {
            return ResponseEntity.ok(done.body());
        }
        if (answer instanceof PlaybookFiles.Refused refused) {
            return ResponseEntity.status(refused.status()).body(refused.body());
        }
        return ResponseEntity.notFound().build();
    }

    /**
     * {@code GET /api/playbooks/contents?dir=&workspace=} : what a registered folder brings (skills,
     * commands, hooks, agents, workflows) with source, hash, state and reach, before anything is
     * installed. A hook's {@code {project}} becomes the workspace, else the launch folder, and the
     * install takes the same folder from its {@code workspace}. Behind the same fence as the writes, because the answer carries the full text of
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
                    ledger, hooksOrigin, projectOf(workspace)));
        } catch (IOException | IllegalStateException failed) {
            return ResponseEntity.status(500).body(Map.of("message", "The contents could not be read: " + failed.getMessage()));
        }
    }

    /**
     * {@code POST /api/playbooks/contents/install {dir, contentsHash, hooks, workspace?}} : installs what a
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
        PlaybookInstaller.Result result = installer().install(real, read.playbook(), text(body, "contentsHash"), hooks,
                projectOf(text(body, "workspace")));
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
     * question, so the preview assumes someone is there to ask. An
     * {@code agent:<name>} role resolves only when the install ledger holds
     * its file for this playbook (card 485).
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
                String id = loaded.playbook().id();
                pinned = PinnedPlaybook.pin(real, loaded.playbook(),
                        name -> skills.find(name).map(Skill::body).orElse(null),
                        source -> ledger.itemHash(id, "agent", source));
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
            String real = Path.of(dir).toRealPath().toString();
            // The answer is the registry's own entry, never the caller's string.
            for (String folder : folders.read().folders()) {
                if (folder.equals(real)) {
                    return Path.of(folder);
                }
            }
            return null;
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
