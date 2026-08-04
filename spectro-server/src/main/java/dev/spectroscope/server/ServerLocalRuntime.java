package dev.spectroscope.server;

import dev.spectroscope.core.local.LlamaServerBinary;
import dev.spectroscope.core.local.LocalCatalog;
import dev.spectroscope.core.local.LocalModel;
import dev.spectroscope.core.local.LocalProviderFactory;
import dev.spectroscope.core.local.LocalRuntime;
import dev.spectroscope.core.local.ModelResolution;
import dev.spectroscope.core.provider.LlmProvider;

import java.nio.file.Path;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * The one {@code llama-server} for this server process, shared across sessions.
 * Lazy: it spawns only when the built-in provider is first used, and it runs
 * whichever catalogue model the operator selected. A llama-server keeps serving
 * the weights it was started with, so a live runtime is only ever reused for
 * the SAME model — switching is a HANDOVER: the new model's subprocess starts
 * and proves healthy first, only then is the old one shut down. A switch to a
 * model that cannot start is refused loudly and the old model keeps serving.
 * The binary comes from the packaged app ({@code spectro.bundle.bin}) or, in
 * dev, from {@code PATH} (a brew-installed {@code llama-server}); the model
 * file from {@link LocalModel}'s roots (bundled or downloaded).
 *
 * <p>Sessions never hold a port. What {@link #provider(String)} hands out is a
 * facade bound to a MODEL id, which resolves the current runtime at each stream
 * call — so a session built before a switch cannot keep POSTing to the loopback
 * port the shutdown released (anything on the machine could bind it next). Its
 * next turn fails with a message naming both models instead (card 107).</p>
 */
public final class ServerLocalRuntime {

    /** Seam: how a {@link LocalRuntime} for one catalogue entry is built.
     *  Production execs the real binary; tests bind stub HTTP servers. */
    interface RuntimeFactory {
        LocalRuntime create(LocalCatalog.Model entry);
    }

    /** Seam: where a catalogue entry's weights live on THIS machine.
     *  Production resolves bundle dir then {@code ~/.spectro/models};
     *  null means absent (the picker shows the chooser dialog). */
    interface ModelLocator {
        Path locate(LocalCatalog.Model entry);
    }

    /** The process-wide instance every static caller shares. */
    private static final ServerLocalRuntime SHARED = new ServerLocalRuntime(
            entry -> new LocalRuntime(
                    (file, port, key) -> launch(file, port, entry.contextTokens(), key),
                    entry.id()),
            entry -> {
                ModelResolution.Resolved model = ModelResolution.locate(
                        LocalModel.bundleDir(), LocalModel.userModelsDir(), entry.file());
                return model.source() == ModelResolution.Source.ABSENT ? null : model.path();
            });

    private final RuntimeFactory factory;
    private final ModelLocator locator;
    private LocalRuntime runtime;
    private String runningModelId;
    /** The delegate on the CURRENT runtime. Built once per runtime, not per
     *  turn: each construction mints a RestClient over its own HttpClient, and
     *  an HttpClient owns a selector thread. Cleared by every runtime handover —
     *  a delegate outliving its runtime points at the released port. */
    private LlmProvider delegate;

    /** Seam constructor — tests inject stub runtimes and a fake model dir. */
    ServerLocalRuntime(RuntimeFactory factory, ModelLocator locator) {
        this.factory = factory;
        this.locator = locator;
    }

    /**
     * The built-in provider for the selected catalogue model, or empty when that
     * model's file isn't present yet (the picker shows the chooser dialog).
     * Idempotent per model — the runtime starts once and is reused until the
     * selection changes.
     *
     * @param modelId the catalogue id from the session's config; null or a stale
     *                id resolve to the catalogue default, the same fallback the
     *                capability profile uses, so what runs and what is advertised
     *                never disagree
     * @return the OpenAI-compatible provider driving the local llama-server, or
     *         empty
     */
    public static Optional<LlmProvider> provider(String modelId) {
        return SHARED.providerFor(modelId);
    }

    /**
     * Instance form of {@link #provider(String)} — the whole state machine, so
     * tests can drive it without the process-wide singleton.
     *
     * @param modelId the catalogue id (null/stale resolve to the default)
     * @return the provider, or empty when the model file is absent
     * @throws IllegalStateException when the model's file exists but its
     *         llama-server never became healthy; on a switch the message says
     *         which model failed AND which one keeps serving — the old runtime
     *         is only shut down after its successor proves itself
     */
    synchronized Optional<LlmProvider> providerFor(String modelId) {
        LocalCatalog.Model entry = LocalCatalog.bundled().resolve(modelId);
        Path file = locator.locate(entry);
        if (file == null) {
            return Optional.empty();
        }
        if (runtime != null && needsRestart(runningModelId, entry.id())) {
            // The handover: prove the NEW model before touching the runtime that
            // live sessions (possibly mid-stream) still depend on. A failed start
            // must not leave the process with no runtime at all.
            LocalRuntime fresh = factory.create(entry);
            // The health proof IS the delegate — building it twice would mint a
            // second HttpClient for the same endpoint.
            LlmProvider proven = LocalProviderFactory.build(fresh, file).orElse(null);
            if (proven == null) {
                fresh.shutdown();
                throw new IllegalStateException("the built-in model \"" + entry.id()
                        + "\" did not become ready — \"" + runningModelId
                        + "\" keeps running and keeps serving");
            }
            LocalRuntime superseded = runtime;
            runtime = fresh;
            runningModelId = entry.id();
            delegate = proven;
            superseded.shutdown();
        }
        if (runtime == null) {
            LocalRuntime fresh = factory.create(entry);
            LlmProvider proven = LocalProviderFactory.build(fresh, file).orElse(null);
            if (proven == null) {
                fresh.shutdown();
                throw new IllegalStateException("the built-in model \"" + entry.id()
                        + "\" did not become ready — its file is on disk but llama-server"
                        + " never answered; check the server log");
            }
            runtime = fresh;
            runningModelId = entry.id();
            delegate = proven;
        }
        return Optional.of(new SessionProvider(entry.id()));
    }

    /**
     * The live delegate for one session's model — resolved at every stream
     * start by the {@link SessionProvider} facade. The RESOLUTION is per turn
     * (that is what catches a switch); the delegate object is per runtime, so a
     * tool-heavy run does not mint an HttpClient per round trip.
     *
     * @param modelId the catalogue id the session selected
     * @return an OpenAI-compatible provider on the CURRENT runtime's endpoint
     * @throws IllegalStateException when the runtime now serves a different
     *         model (the switch happened after this session picked its model) —
     *         loud and readable, instead of an I/O error against a freed port
     */
    synchronized LlmProvider liveDelegate(String modelId) {
        if (runtime == null || !modelId.equals(runningModelId)) {
            String now = runningModelId == null
                    ? "no model is running"
                    : "the runtime now serves \"" + runningModelId + "\"";
            throw new IllegalStateException("the built-in model was switched: this session"
                    + " selected \"" + modelId + "\" but " + now
                    + " — pick a model in the provider picker to continue");
        }
        Path file = locator.locate(LocalCatalog.bundled().resolve(modelId));
        if (file == null) {
            throw new IllegalStateException("the built-in model \"" + modelId
                    + "\" is no longer on disk — download it from the provider picker");
        }
        if (delegate == null) {
            delegate = LocalProviderFactory.build(runtime, file).orElseThrow(
                    () -> new IllegalStateException("the built-in model \"" + modelId
                            + "\" stopped answering — restart it from the provider picker"));
        }
        return delegate;
    }

    /**
     * What a session actually holds: a provider bound to a MODEL, not to a
     * port. Each stream call resolves the current runtime, so a model switch
     * elsewhere turns this session's next turn into a readable refusal instead
     * of a POST against whatever now owns the freed loopback port.
     */
    private final class SessionProvider implements LlmProvider {

        private final String modelId;

        private SessionProvider(String modelId) {
            this.modelId = modelId;
        }

        @Override
        public Iterable<ProviderEvent> stream(ProviderRequest request) {
            return liveDelegate(modelId).stream(request);
        }

        /** The model this SESSION selected — what {@code run_start} must stamp,
         *  whether or not the shared runtime still serves it. */
        @Override
        public String modelName() {
            return modelId;
        }

        @Override
        public String providerName() {
            return "spectro-local";
        }
    }

    /**
     * Whether a live runtime must be replaced for the requested model.
     *
     * @param running   the model the runtime was started with, or null when none runs
     * @param requested the model the operator wants now
     * @return true only when a DIFFERENT model is requested while one runs
     */
    static boolean needsRestart(String running, String requested) {
        return running != null && !Objects.equals(running, requested);
    }

    /**
     * The llama-server invocation, assembled pure so the flags are testable.
     *
     * @param binary        the llama-server executable
     * @param model         the GGUF path
     * @param port          the loopback port
     * @param contextTokens the catalogue model's context window
     * @return the full command line
     */
    static List<String> buildCommand(String binary, Path model, int port, int contextTokens,
                                     String apiKey) {
        return List.of(binary,
                "-m", model.toString(),
                "--host", "127.0.0.1",
                "--port", String.valueOf(port),
                "-c", String.valueOf(contextTokens),
                // Loopback alone is not a fence: llama.cpp sets CORS to '*', so a
                // page in the operator's browser can find this port and read from
                // it. The key is minted per launch by LocalRuntime.
                "--api-key", apiKey,
                "--jinja");
    }

    /** Exec {@code llama-server} on the model + port; the runtime's JVM
     *  shutdown-hook reaper closes the handle, so the child dies with the JVM. */
    private static AutoCloseable launch(Path model, int port, int contextTokens, String apiKey)
            throws Exception {
        ProcessBuilder pb = new ProcessBuilder(
                buildCommand(binary(), model, port, contextTokens, apiKey));
        pb.redirectErrorStream(true);
        pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
        Process process = pb.start();
        return process::destroy;
    }

    /** The llama-server binary: bundled next to the app if packaged, else PATH. */
    private static String binary() {
        return LlamaServerBinary.command();
    }

    /**
     * Whether a {@code llama-server} exists for this install at all. The desktop
     * run kit bundles one, so the built-in path needs nothing installed; the bare
     * server jar and the CLI do not, and there the operator supplies it
     * ({@code brew install llama.cpp}). The chooser asks this before promising a
     * model will run, because a missing binary otherwise surfaces as a spawn that
     * fails after a multi-gigabyte download.
     *
     * <p>The lookup itself moved to {@link LlamaServerBinary} in core when the
     * CLI's doctor started asking the same question (card 164) — two faces, one
     * rule.</p>
     *
     * @return true when a bundled or PATH llama-server is executable
     */
    public static boolean binaryAvailable() {
        return LlamaServerBinary.available();
    }
}
