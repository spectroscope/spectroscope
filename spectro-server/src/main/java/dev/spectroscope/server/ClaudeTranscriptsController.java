package dev.spectroscope.server;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.stream.Stream;

/**
 * Read-only browser for the Claude Code transcript store under
 * {@code ~/.claude/projects}. The folder is invisible in Finder, so the web
 * import dialog cannot reach it through a file chooser — these two endpoints
 * list the *.jsonl transcripts and hand one over for the import path.
 *
 * Strictly sandboxed: only files inside the base directory, only .jsonl, the
 * requested path is resolved canonically before it is read (no traversal, no
 * symlink escape — request parameters are untrusted input).
 *
 * <p>Both endpoints wear the local-origin fence (card 74). What they answer
 * with is every prompt the operator ever typed and every tool result that came
 * back, and a DNS-rebound page arrives on loopback like the real UI does, so
 * the Host header is the only part of the request that tells them apart.</p>
 */
@RestController
public class ClaudeTranscriptsController {

    /**
     * One transcript in the listing; path is relative to the base.
     *
     * @param path the base-relative path — what the content endpoint takes back
     * @param project the first path segment, i.e. the Claude Code project folder
     * @param file the bare file name
     * @param size file size in bytes (0 when the file vanished mid-listing)
     * @param modifiedAt last-modified epoch millis — the listing sorts by this
     */
    public record TranscriptInfo(
            String path, String project, String file, long size, long modifiedAt, boolean loadable) {}

    /**
     * The listing and BOTH limits that govern it, in one answer.
     *
     * <p>There are two, and this record used to publish one. The byte ceiling
     * refuses a named file the caller can see; the row cap drops files the
     * caller never learns about, which is the worse of the pair to keep quiet.
     * The sibling {@link WorkspaceController.FilesResponse} has carried the same
     * flag for the same reason since it was written.</p>
     *
     * @param limitBytes the largest transcript {@link #content} will serve
     * @param truncated {@code true} when the row cap dropped transcripts the
     *                  store really holds — the listing is incomplete
     * @param transcripts the rows, newest first
     */
    public record TranscriptListing(
            long limitBytes, boolean truncated, List<TranscriptInfo> transcripts) {}

    /**
     * The most rows one listing returns.
     *
     * <p>Counted on this machine's store 2026-08-03: the walk descends four
     * levels and so reaches {@code <project>/<session>/subagents/agent-*.jsonl}
     * as well as the session transcripts themselves, which put 853 candidates in
     * front of this cap. 181 of the 300 served slots went to subagent files and
     * 36 ordinary session transcripts fell off the end, all of them far under
     * the byte ceiling. The store is live, so those are a reading and not a
     * constant. Whether the split is right is a product question; whether the
     * caller is told the cap fired is not.</p>
     */
    private static final int MAX_LISTED = 300;

    /**
     * The largest transcript this server hands over, published by the listing and
     * enforced by {@link #content} from this one constant. Two literals would
     * drift, and the drift reads as the dialog offering the one file the server
     * refuses, which is the bug this whole change is about.
     *
     * <p>Raised from 64 MB once {@link #content} stopped reading the file into
     * heap. The old number was the server's heap budget: {@code Files.readString}
     * held the whole file as a UTF-16 String, measured at exactly 2.00x the file
     * in thread allocation, and Spring encoded it back to UTF-8 for the wire. A
     * streamed read makes the server's cost a buffer, so the ceiling is now a
     * statement about the browser instead, which holds the response text and the
     * folded rows.
     *
     * <p>128 MiB covers the whole real store with headroom: the largest
     * transcript on this machine is 82.9 MiB and the owner's is 73.6 MiB and
     * growing. It is not unbounded, because the client cost is real: 82.9 MiB
     * folds to 9931 rows and about 278 MB retained in the tab.
     */
    private static final long MAX_CONTENT_BYTES = 128L * 1024 * 1024;

    /**
     * The most transcripts one facts call will fold.
     *
     * <p>This is the bound on work per request, and it is deliberately about a
     * screen rather than a store. The dialog asks for the rows it is showing,
     * so a batch is a viewport: about a dozen rows, asked again as the operator
     * scrolls. Twenty-four leaves headroom for a tall window and a prefetch
     * either side of it without ever letting one request walk the whole listing.
     *
     * <p>What that costs, measured on the operator's real store: a transcript
     * folds at about 719 MB/s, so the 8.4 MB average costs roughly 12 ms and a
     * full batch of average rows about 280 ms. A batch of the largest files in
     * the store would cost near 2.8 s, which is the honest worst case and the
     * reason the client asks per visible row instead of for everything at once.
     * Every one of those reads is then cached, so the second look is free.
     */
    static final int MAX_FACT_BATCH = 24;

    private final Path base;

    /** Folded transcripts, kept between calls. */
    private final TranscriptFactsCache facts = new TranscriptFactsCache();
    /** One model-written line per transcript, on disk (card 179 stage 3). */
    private final TranscriptGists gists = TranscriptGists.inHome();
    /** The thing that spends the operator's key, only when he presses. */
    private final GistWriter gistWriter = new GistWriter();

    /** Spring wiring: the real transcript store under {@code ~/.claude/projects}. */
    public ClaudeTranscriptsController() {
        this(Path.of(System.getProperty("user.home"), ".claude", "projects"));
    }

    /**
     * Seam for tests: point the controller at a throwaway base directory.
     *
     * @param base the directory to treat as the sandboxed transcript store
     */
    ClaudeTranscriptsController(Path base) {
        this.base = base;
    }

    /**
     * All *.jsonl transcripts under the base, newest first, capped.
     *
     * @param request the servlet request, for the local-origin fence
     * @return 404 for a non-local caller or a rebound Host; else the transcript
     *         descriptors — an absent or unreadable store answers an empty list,
     *         never an error (browsing must not break the dialog)
     */
    @GetMapping("/api/claude/transcripts")
    public ResponseEntity<TranscriptListing> transcripts(HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)) {
            return ResponseEntity.status(404).build(); // no fingerprint in the refusal
        }
        return ResponseEntity.ok(listing());
    }

    /**
     * The listing itself, fence already passed.
     *
     * <p>Counted before the cap is applied, not after: {@code limit} on the
     * stream cannot tell a store of exactly 300 from one of 900.</p>
     *
     * @return the rows plus both limits that govern them
     */
    private TranscriptListing listing() {
        if (!Files.isDirectory(base)) {
            return new TranscriptListing(MAX_CONTENT_BYTES, false, List.of());
        }
        try (Stream<Path> walk = Files.walk(base, 4)) {
            List<TranscriptInfo> found = walk
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().endsWith(".jsonl"))
                    .map(this::describe)
                    .sorted(Comparator.comparingLong(TranscriptInfo::modifiedAt).reversed())
                    .toList();
            boolean capped = found.size() > MAX_LISTED;
            return new TranscriptListing(MAX_CONTENT_BYTES, capped,
                    capped ? List.copyOf(found.subList(0, MAX_LISTED)) : found);
        } catch (IOException unreadable) {
            return new TranscriptListing(MAX_CONTENT_BYTES, false, List.of());
        }
    }

    /**
     * One transcript's raw JSONL — the client runs it through detectAndLoad.
     *
     * @param rel the base-relative path from the listing — canonicalized and
     *            checked against the real base before any read
     * @param request the servlet request, for the local-origin fence
     * @return 200 streaming the UTF-8 body; 404 for a non-local caller or a
     *         rebound Host; 400 for a non-.jsonl name, 404 for anything outside
     *         the base or missing, 413 above {@link #MAX_CONTENT_BYTES} with a
     *         body naming the file's size and that cap, so the dialog can say
     *         why rather than print a number
     */
    @GetMapping("/api/claude/transcripts/content")
    public ResponseEntity<Resource> content(@RequestParam("path") String rel,
            HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)) {
            return ResponseEntity.status(404).build(); // no fingerprint in the refusal
        }
        if (!rel.endsWith(".jsonl")) {
            return ResponseEntity.badRequest().build();
        }
        try {
            Path requested = base.resolve(rel).normalize();
            // Canonical check: the REAL location must stay inside the REAL base.
            Path real = requested.toRealPath();
            if (!real.startsWith(base.toRealPath()) || !Files.isRegularFile(real)) {
                return ResponseEntity.notFound().build();
            }
            long size = Files.size(real);
            if (size > MAX_CONTENT_BYTES) {
                return ResponseEntity.status(413)
                        .contentType(new MediaType(MediaType.TEXT_PLAIN, StandardCharsets.UTF_8))
                        .body(new ByteArrayResource(("transcript is " + size
                                + " bytes, this server reads at most " + MAX_CONTENT_BYTES)
                                .getBytes(StandardCharsets.UTF_8)));
            }
            // A resource, not a String. Spring copies it to the socket in
            // chunks, so a 128 MB transcript costs this server a buffer instead
            // of 256 MB of UTF-16 plus the re-encoded copy.
            return ResponseEntity.ok()
                    .contentType(new MediaType(MediaType.TEXT_PLAIN, StandardCharsets.UTF_8))
                    .contentLength(size)
                    .body(new FileSystemResource(real));
        } catch (IOException | InvalidPathException missing) {
            // InvalidPathException too: `resolve` throws it, unchecked, for a
            // name this filesystem cannot even spell (a NUL byte). Uncaught it
            // left the handler as a 500 with Spring's default body — which
            // hands a prober their own string back and, worse, tells them this
            // path was DIFFERENT from the ones that answer 404.
            return ResponseEntity.notFound().build();
        }
    }

    /**
     * The facts batch and the cap that governs it.
     *
     * @param maxBatch the most paths one call folds, published so the client
     *                 does not have to hardcode the server's number
     * @param facts one row per path that named a real transcript inside the
     *              store, in the order asked; a path that named anything else
     *              yields no row at all
     */
    public record FactsResponse(int maxBatch, List<TranscriptFacts.Facts> facts) {}

    /**
     * What the listed transcripts contain, for a bounded batch of them.
     *
     * <p>Separate from the listing on purpose. The listing is a directory walk
     * and answers in milliseconds; this reads transcript bodies. Folding them
     * into one call would make the dialog wait for the second before it could
     * draw the first, and a dialog that waits for an index is worse than one
     * without facts. So the list renders from {@link #transcripts} immediately
     * and the facts arrive per visible row, blank until they do.</p>
     *
     * @param paths base-relative transcript paths from the listing, at most
     *              {@link #MAX_FACT_BATCH} of which are honoured
     * @param request the servlet request, for the local-origin fence
     * @return 404 for a non-local caller or a rebound Host; else one row per
     *         readable path. A path outside the store, a non-{@code .jsonl}
     *         name and a file that is not there are all the same answer —
     *         nothing — because a request parameter is untrusted input and a
     *         refusal that distinguishes them tells a prober what exists
     */
    @GetMapping("/api/claude/transcripts/facts")
    public ResponseEntity<FactsResponse> facts(
            @RequestParam(name = "path", required = false) List<String> paths,
            HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)) {
            return ResponseEntity.status(404).build(); // no fingerprint in the refusal
        }
        if (paths == null || paths.isEmpty()) {
            return ResponseEntity.ok(new FactsResponse(MAX_FACT_BATCH, List.of()));
        }
        List<TranscriptFacts.Facts> rows = new ArrayList<>();
        for (String rel : paths.subList(0, Math.min(paths.size(), MAX_FACT_BATCH))) {
            Path file = insideStore(rel);
            if (file != null) {
                // Sidecar counts are taken NOW, not from the cache: the agent
                // folder fills up while the parent transcript sits unchanged,
                // and a count cached under the transcript's stamp was measured
                // answering yesterday's number for as long as it sat still.
                rows.add(facts.facts(file)
                        .withSidecars(TranscriptFacts.sidecarsBeside(file))
                        .at(rel));
            }
        }
        return ResponseEntity.ok(new FactsResponse(MAX_FACT_BATCH, List.copyOf(rows)));
    }

    /** One row of the gist surface. */
    public record GistRow(String path, String text, String model, boolean stale) {}

    /** What the dialog gets back from either gist call. */
    public record GistsResponse(List<GistRow> gists, int written, String error) {}

    /** Which transcripts to read, and whether to ignore what is already stored. */
    public record GistRequest(List<String> paths, boolean all) {}

    /**
     * {@code GET /api/claude/transcripts/gists}: every gist already on disk.
     *
     * <p>Free — no model, no transcript read. The dialog calls it on open so the
     * rows an operator already paid for are simply there, which is the whole
     * point of storing them.</p>
     *
     * @param request the servlet request, for the local-origin fence
     * @return the stored gists, each marked {@code stale} when the transcript
     *         has changed since it was written
     */
    @GetMapping("/api/claude/transcripts/gists")
    public ResponseEntity<GistsResponse> storedGists(HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)) {
            return ResponseEntity.status(404).build();
        }
        List<GistRow> rows = new ArrayList<>();
        gists.all().forEach((path, g) -> {
            Path file = insideStore(path);
            boolean stale = file == null || !TranscriptGists.stampOf(file).equals(g.stamp());
            rows.add(new GistRow(path, g.text(), g.model(), stale));
        });
        return ResponseEntity.ok(new GistsResponse(List.copyOf(rows), 0, null));
    }

    /**
     * {@code POST /api/claude/transcripts/gists}: write the missing ones.
     *
     * <p>The operator pressed a button, so this spends his key — the same fence
     * pair the key-write and explain endpoints wear, for the same reason.</p>
     *
     * <p>Only the ones that need it. A path whose stored gist matches the file's
     * current stamp is skipped, so pressing again after adding transcripts costs
     * only the new ones. {@code all: true} clears the store first, which is the
     * "do them again with a different model" button: a half-finished re-run must
     * not leave two models' sentences beside each other.</p>
     *
     * @param body the paths, and whether to redo everything
     * @param request the servlet request, for the fences
     * @return the gists for the requested paths and how many were written; on a
     *         provider that will not build, the readable reason and nothing else
     */
    @PostMapping(value = "/api/claude/transcripts/gists", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<GistsResponse> writeGists(@RequestBody(required = false) GistRequest body,
                                                    HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request) || !FleetController.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.status(404).build();
        }
        List<String> paths = body == null || body.paths() == null ? List.of() : body.paths();
        if (body != null && body.all()) {
            gists.clear();
        }
        return ResponseEntity.ok(gistWriter.write(paths, gists, this::insideStore));
    }

    /**
     * The agents beside one session, named.
     *
     * @param agents one row per {@code agent-*.jsonl}, direct spawns first
     */
    public record SidecarsResponse(List<TranscriptFacts.SidecarAgent> agents) {}

    /**
     * {@code GET /api/claude/transcripts/sidecars}: which agent transcripts sit
     * beside this session, without reading a byte of any of them.
     *
     * <p>This is the read that lets an imported session stop saying "not in
     * this stream: the per-agent rows, tokens, tool calls". A Claude Code
     * session transcript holds only its own start — measured over the 25
     * largest in this store, 71,329 records and ZERO carrying
     * {@code isSidechain} — and every word its agents said is in these
     * siblings. The filename carries the agent id, which is the same id the
     * parent's spawn row carries, so the docking point is read and never
     * invented.</p>
     *
     * <p>A LISTING, deliberately. Opening a session must cost one directory
     * walk, not the 4,000-odd file reads a full join would be; the bodies come
     * one at a time from {@link #content} when a reader opens a row. That bound
     * is the whole design, and it is card 151's lesson applied before it can be
     * repeated here.</p>
     *
     * @param rel the session transcript, store-relative
     * @param request the servlet request, for the local-origin fence
     * @return 404 for a non-local caller or a rebound Host; else the agents,
     *         empty when the session has no sidecar folder — the same shape as
     *         a session that spawned nothing, which is what it is
     */
    @GetMapping("/api/claude/transcripts/sidecars")
    public ResponseEntity<SidecarsResponse> sidecars(
            @RequestParam(name = "path") String rel, HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)) {
            return ResponseEntity.status(404).build(); // no fingerprint in the refusal
        }
        Path file = insideStore(rel);
        if (file == null) {
            return ResponseEntity.ok(new SidecarsResponse(List.of()));
        }
        return ResponseEntity.ok(new SidecarsResponse(TranscriptFacts.sidecarAgentsBeside(file, base)));
    }

    /**
     * {@code GET /api/claude/transcripts/folders}: which of a session's three
     * folders are really on disk.
     *
     * <p>The store lives under a dot-folder Finder hides and the scratchpad
     * under a temp path nobody would guess, so a session's own files are
     * unreachable from the app that is reading them. This says which of the
     * three exist; the UI offers a button only for those, because a button that
     * opens nothing is a small lie.</p>
     *
     * <p>Asked per request rather than cached: a scratchpad appears when a run
     * makes one and a temp sweep takes it away again.</p>
     *
     * @param rel the session transcript, store-relative
     * @param request the servlet request, for the local-origin fence
     * @return which folders are there, and their absolute paths so the button
     *         can say where it goes; empty for anything that is not a transcript
     */
    @GetMapping("/api/claude/transcripts/folders")
    public ResponseEntity<FoldersResponse> folders(
            @RequestParam(name = "path") String rel, HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)) {
            return ResponseEntity.status(404).build();
        }
        Path file = insideStore(rel);
        if (file == null) {
            return ResponseEntity.ok(new FoldersResponse(List.of()));
        }
        List<FolderInfo> found = new ArrayList<>();
        for (SessionFolders.Kind kind : SessionFolders.Kind.values()) {
            Path folder = SessionFolders.locate(file, kind);
            if (SessionFolders.isThere(folder)) {
                found.add(new FolderInfo(kind.name().toLowerCase(Locale.ROOT), folder.toString()));
            }
        }
        return ResponseEntity.ok(new FoldersResponse(List.copyOf(found)));
    }

    /**
     * {@code POST /api/claude/transcripts/folders/open}: show one of them.
     *
     * <p><b>The path is never the caller's.</b> The body names a transcript and
     * a KIND; the server resolves the transcript through the same fence every
     * read here uses and derives the folder itself. An endpoint that opened a
     * path off the wire would be a way to run the machine's file manager on any
     * file on the disk, from any page the browser happens to be showing — and
     * the fence in front of it is a fence, not a guarantee, which is exactly
     * what {@code /%61pi/config} demonstrated in v0.6.1.</p>
     *
     * @param body the transcript and which folder
     * @param request the servlet request, for the local-origin fence
     * @return what happened, so the UI can say "not there" rather than nothing
     */
    @PostMapping(value = "/api/claude/transcripts/folders/open",
            consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<OpenResponse> openFolder(
            @RequestBody OpenRequest body, HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)) {
            return ResponseEntity.status(404).build();
        }
        Path file = body == null ? null : insideStore(body.path());
        SessionFolders.Kind kind = kindOf(body == null ? null : body.what());
        if (file == null || kind == null) {
            return ResponseEntity.ok(new OpenResponse("missing"));
        }
        FolderOpener.Result result = FolderOpener.open(SessionFolders.locate(file, kind));
        return ResponseEntity.ok(new OpenResponse(result.name().toLowerCase(Locale.ROOT)));
    }

    /**
     * The kind a caller named, or null for anything else.
     *
     * <p>{@code valueOf} would throw on a name that is not one of ours, and an
     * unknown kind is a caller error rather than a server one.</p>
     *
     * @param what the wire word
     * @return the kind, or null
     */
    private static SessionFolders.Kind kindOf(String what) {
        if (what == null) {
            return null;
        }
        for (SessionFolders.Kind kind : SessionFolders.Kind.values()) {
            if (kind.name().equalsIgnoreCase(what)) {
                return kind;
            }
        }
        return null;
    }

    /** One folder that exists, and where it is. */
    record FolderInfo(String kind, String path) {}

    /** Which of a session's folders are on disk. */
    record FoldersResponse(List<FolderInfo> folders) {}

    /** Which folder of which session to show. */
    record OpenRequest(String path, String what) {}

    /** {@code opened}, {@code missing} or {@code unsupported}. */
    record OpenResponse(String result) {}

    /**
     * Resolves a caller-supplied path to a real transcript inside the store, or
     * to nothing.
     *
     * <p>The same canonical check {@link #content} makes, for the same reason:
     * the path came off the wire, so {@code ..} and a symlink pointing out of
     * the store are both things a caller can write. The real location is
     * resolved before anything reads it.</p>
     *
     * @param rel the base-relative path as asked
     * @return the absolute file, or null when it is not a transcript in the store
     */
    private Path insideStore(String rel) {
        if (rel == null || !rel.endsWith(".jsonl")) {
            return null;
        }
        try {
            Path real = base.resolve(rel).normalize().toRealPath();
            if (!real.startsWith(base.toRealPath()) || !Files.isRegularFile(real)) {
                return null;
            }
            return real;
        } catch (IOException | InvalidPathException missing) {
            // Unchecked, and thrown by `resolve` before any I/O happens: a NUL
            // byte in the parameter. It used to leave this method, escape the
            // batch loop above — abandoning every row queued behind it — and
            // answer 500, against this endpoint's own promise that everything
            // untrusted gets the same nothing.
            return null;
        }
    }

    /**
     * Builds one listing row — stat failures degrade to zeros rather than
     * dropping the file from the list.
     *
     * @param file the absolute transcript path under the base
     * @return the descriptor with base-relative path, project folder and stat data
     */
    private TranscriptInfo describe(Path file) {
        Path rel = base.relativize(file);
        String project = rel.getNameCount() > 1 ? rel.getName(0).toString() : "";
        long size;
        long modified;
        try {
            size = Files.size(file);
            modified = Files.getLastModifiedTime(file).toMillis();
        } catch (IOException gone) {
            size = 0;
            modified = 0;
        }
        return new TranscriptInfo(
                rel.toString(), project, file.getFileName().toString(), size, modified,
                size <= MAX_CONTENT_BYTES);
    }
}
