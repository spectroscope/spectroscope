package dev.spectroscope.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.cli.speech.SpeechRenderer;
import dev.spectroscope.cli.speech.TtsConfig;
import dev.spectroscope.cli.trace.TracingProvider;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.ProviderFactory;
import dev.spectroscope.core.config.WorkspaceResolver;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.events.RunEvent.Attachment;
import dev.spectroscope.core.scheduler.HeadlessRunner;
import dev.spectroscope.core.scheduler.HeadlessRunners;
import dev.spectroscope.core.session.SessionStore;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;
import picocli.CommandLine.ParentCommand;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.function.Consumer;

/**
 * spectroscope run -p "..." [--json] [--max-turns N] [--permissions readonly|auto] [--image path] [--speak]
 *
 * <p>Runs one prompt headless and prints the final result — or, with --json, every
 * RunEvent as one NDJSON line on stdout. Exit code 0 only on a regular end_turn;
 * otherwise 1, with the reason on stderr. The permission policy is explicit and
 * defaults to readonly: capability before convenience.
 *
 * <p>{@code --image} (repeatable) attaches images to the prompt. The bytes
 * land in the session's blob store; the run_start event carries only references.
 * {@code --image} exists only on this headless command — a deliberate boundary: the
 * interactive REPL runs through the subagent manager, and images enter
 * interactively through the web UI.</p>
 *
 * <p>{@code --speak} reads the answer aloud while it streams (a second event
 * consumer next to the NDJSON writer; the core is untouched).</p>
 */
@Command(name = "run", description = "Run one prompt headless (NDJSON with --json).")
public final class RunCommand implements Callable<Integer> {

    @Option(names = {"-p", "--prompt"}, required = true, description = "The task text.")
    private String prompt;

    @Option(names = "--json", description = "Emit every RunEvent as NDJSON on stdout.")
    private boolean json;

    @Option(names = "--max-turns", description = "Cancel the run when a turn exceeds this 1-based limit.")
    private Integer maxTurns;

    @Option(names = "--permissions", defaultValue = "readonly",
            description = "Headless policy: readonly (default) or auto.")
    private String permissions;

    @Option(names = "--verbose", description = "Trace the agent<->provider protocol on stderr (cyan).")
    private boolean verbose;

    @Option(names = "--image", paramLabel = "<path>",
            description = "Attach an image to the prompt (repeatable; jpg, jpeg, png, webp, gif).")
    private List<Path> images = new ArrayList<>();

    @Option(names = "--speak", description = "Speak the answer aloud while it streams.")
    private boolean speak = false;

    @ParentCommand
    private SpectroCli parent;

    /** Global flags (--provider/--model/--base-url) come from the parent command;
     *  standalone construction (tests) falls back to no overrides.
     *
     * @return the flag-derived overrides, or {@link SpectroConfig.Overrides#none()} without a parent
     */
    SpectroConfig.Overrides effectiveOverrides() {
        return parent != null ? parent.cliOverrides() : SpectroConfig.Overrides.none();
    }

    /**
     * The headless run: validates the flags, loads config, stores any {@code --image}
     * attachments as blobs, then executes the prompt once with speech and NDJSON as
     * optional event consumers. In {@code --json} mode stdout carries ONLY NDJSON;
     * every diagnostic goes to stderr.
     *
     * @return 0 only on a regular {@code end_turn}; 1 for invalid flags, a bad image,
     *         a missing key, or any other stop reason (named on stderr with the session id)
     */
    @Override
    public Integer call() {
        if (!"readonly".equals(permissions) && !"auto".equals(permissions)) {
            System.err.println("--permissions must be \"readonly\" or \"auto\" (headless default: readonly).");
            return 1;
        }
        if (maxTurns != null && maxTurns < 1) {
            System.err.println("--max-turns must be an integer >= 1.");
            return 1;
        }

        ObjectMapper mapper = new ObjectMapper();
        SpectroConfig.ensureSeeded(System.getenv()); // first boot: materialize the env base once
        SpectroConfig config = SpectroConfig.load(effectiveOverrides());
        LogSetup.apply(config.logLevel()); // config-effective level onto the root
        boolean autoApprove = "auto".equals(permissions);

        // The store is minted HERE (not left to the runner): the auto workspace is
        // keyed by the session id, and blobs live under the session's own
        // blobs directory. An invalid image prints its reason and exits 1 — the run
        // never starts.
        SessionStore store = new SessionStore();
        Path workspace = WorkspaceResolver.resolve(config.workspace(), store.id());

        // The session moment: the workspace's own .spectro pair joins the chain
        // now that workspace is resolved — flags (effectiveOverrides) stay the
        // top layer. A broken workspace file is loud but never fatal: the run
        // simply keeps the process-moment config it already had.
        Path projectDir = Path.of(System.getProperty("user.dir"));
        try {
            config = SpectroConfig.loadForWorkspace(effectiveOverrides(), projectDir, workspace);
        } catch (IllegalArgumentException invalidWorkspaceScope) {
            System.err.println("workspace settings ignored: " + invalidWorkspaceScope.getMessage());
        }

        List<Attachment> attachments = new ArrayList<>();
        if (!images.isEmpty()) {
            try {
                for (Path imagePath : images) {
                    attachments.add(loadImageAttachment(store.id(), imagePath));
                }
            } catch (IllegalArgumentException invalidImage) {
                System.err.println(invalidImage.getMessage());
                return 1;
            }
        }

        // voice output as a second event consumer. --speak overrides the
        // tts.enabled config switch; the tts block is read in spectro-cli so spectro-core
        // stays byte-identical. It hangs off the SAME event callback the runner already
        // exposes — no new core seam.
        TtsConfig tts = TtsConfig.load();
        SpeechRenderer speech = new SpeechRenderer(tts.voice(), speak || tts.enabled());

        // The headless run loop lives in HeadlessRunner (spectro-core, untouched); the
        // speech renderer hangs off the SAME per-event callback the runner exposes —
        // that IS the "second consumer" seam, no core edit. --json still emits NDJSON.
        Consumer<RunEvent> onEvent = event -> {
            speech.onEvent(event);
            if (json) {
                emitNdjson(mapper, event);
            }
        };

        // In --json mode stdout carries ONLY NDJSON; everything else goes to stderr.
        HeadlessRunner.Outcome outcome;
        try {
            // --verbose traces the wire on stderr, so --json stdout stays clean.
            HeadlessRunner runner = verbose
                    ? HeadlessRunners.withProvider(mapper, config, new TracingProvider(
                            ProviderFactory.providerFromConfig(config),
                            config.provider() + " · " + config.model()))
                    : new HeadlessRunner(mapper, config);
            outcome = runner.runOnce(
                    prompt, workspace, autoApprove, maxTurns,
                    onEvent,
                    System.err::println,
                    store, List.copyOf(attachments));
        } catch (IllegalStateException missingKey) {
            System.err.println(missingKey.getMessage());
            speech.close();
            return 1;
        }

        // Wait for the last sentence to finish before the process exits (otherwise the
        // exit would cut playback off), then release the synth/playback workers.
        speech.idle();
        speech.close();

        if (outcome.exitOk()) {
            if (!json) {
                System.out.println(outcome.finalText().stripTrailing()); // the final result
            }
            return 0;
        }
        // Exit != 0: the reason on stderr, always naming the session for later inspection.
        System.err.println("Run did not end regularly (" + outcome.stopReason()
                + "). Session: " + outcome.sessionId());
        return 1;
    }

    private static final Map<String, String> EXTENSION_MEDIA_TYPES = Map.of(
            ".jpg", "image/jpeg", ".jpeg", "image/jpeg", ".png", "image/png",
            ".webp", "image/webp", ".gif", "image/gif");

    /**
     * Reads an image file, stores it as a blob, and returns the attachment reference.
     * The format check runs on the file extension; unsupported or unreadable files
     * throw {@link IllegalArgumentException} with the message the CLI prints verbatim.
     *
     * @param sessionId the session whose blob store receives the bytes
     * @param filePath  the image on disk (jpg, jpeg, png, webp or gif)
     * @return the reference (kind, media type, blob path, sha256) that rides in
     *         {@code run_start} — the JSONL never carries the bytes
     */
    static Attachment loadImageAttachment(String sessionId, Path filePath) {
        String fileName = filePath.getFileName().toString().toLowerCase(Locale.ROOT);
        int dotIndex = fileName.lastIndexOf('.');
        String extension = dotIndex >= 0 ? fileName.substring(dotIndex) : "";
        String mediaType = EXTENSION_MEDIA_TYPES.get(extension);
        if (mediaType == null) {
            throw new IllegalArgumentException("Unsupported image format: \"" + filePath
                    + "\" (allowed: jpg, jpeg, png, webp, gif)");
        }
        final byte[] bytes;
        try {
            bytes = Files.readAllBytes(filePath);
        } catch (IOException readFailure) {
            throw new IllegalArgumentException("Cannot read image file: " + filePath, readFailure);
        }
        SessionStore.StoredBlob blob = SessionStore.saveBlob(sessionId, bytes, mediaType);
        return new Attachment("image", mediaType, blob.blobPath(), blob.sha256());
    }

    /**
     * One RunEvent as one JSON line on stdout — byte-identical to the JSONL persistence format.
     *
     * @param mapper serializes the event; a failure is reported on stderr, never on stdout
     * @param event  the event to emit
     */
    private static void emitNdjson(ObjectMapper mapper, RunEvent event) {
        try {
            System.out.println(mapper.writeValueAsString(event));
        } catch (Exception serialization) {
            System.err.println("NDJSON serialization failed: " + serialization.getMessage());
        }
    }
}
