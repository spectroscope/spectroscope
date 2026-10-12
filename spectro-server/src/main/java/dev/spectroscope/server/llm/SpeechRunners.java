package dev.spectroscope.server.llm;

import dev.spectroscope.cli.voice.ProcessCommandRunner;
import dev.spectroscope.cli.voice.Transcriber;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.config.SttRunnerChoice;
import dev.spectroscope.core.config.SttStreaming;

import java.nio.file.Path;
import java.util.Objects;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

/**
 * The runners of the local live route, one set per spectro process (card 528).
 *
 * <p>A session on {@code cli} gets whisper-cli. Every session on
 * {@code server} gets the one resident {@link WhisperServerRunner}, so the
 * model is loaded once for all of them. The production instance checks the
 * idle time every minute and stops the server when the JVM shuts down; the
 * socket configuration also stops it when the Spring context closes.</p>
 */
public final class SpeechRunners {

    /** How often the idle time is checked. */
    private static final long REAP_EVERY_SECONDS = 60L;

    private static SpeechRunners shared;

    private final Function<String, WhisperServerRunner> servers;
    private final LocalWhisperUpstream.WindowRunner cli;
    private WhisperServerRunner server;
    private String serverBinary;

    /**
     * Seam for tests.
     *
     * @param servers builds a server runner for a whisper-server binary
     * @param cli the whisper-cli runner
     */
    SpeechRunners(Function<String, WhisperServerRunner> servers, LocalWhisperUpstream.WindowRunner cli) {
        this.servers = servers;
        this.cli = cli;
    }

    /**
     * The process's runners: whisper-cli over the configured model, and a
     * whisper-server built on first use, logging under the system temp folder.
     *
     * @return the shared instance
     */
    public static synchronized SpeechRunners shared() {
        if (shared == null) {
            Path logDir = Path.of(System.getProperty("java.io.tmpdir"), "spectroscope-whisper-server");
            SpeechRunners made = new SpeechRunners(
                    binary -> WhisperServerRunner.production(Path.of(binary),
                            TranscribeController::configuredModelPath, logDir,
                            SttStreaming.STT_WARMUP_TIMEOUT_MS, SttStreaming.STT_SERVER_IDLE_MS),
                    (wav, language) -> new Transcriber(new ProcessCommandRunner(),
                            TranscribeController.configuredModelPath()).transcribe(wav, language));
            ScheduledExecutorService reaper = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "stt-server-reaper");
                t.setDaemon(true);
                return t;
            });
            reaper.scheduleAtFixedRate(made::reap, REAP_EVERY_SECONDS, REAP_EVERY_SECONDS, TimeUnit.SECONDS);
            Runtime.getRuntime().addShutdownHook(new Thread(made::stopAll, "stt-server-stop"));
            shared = made;
        }
        return shared;
    }

    /** Stops the shared server, if one was ever built: the Spring context closes. */
    public static void stopShared() {
        SpeechRunners made;
        synchronized (SpeechRunners.class) {
            made = shared;
        }
        if (made != null) {
            made.stopAll();
        }
    }

    /**
     * The runner for a session that opens with this choice.
     *
     * @param choice what {@code sttRunner} resolved to
     * @return the resident server for {@code server}, whisper-cli otherwise
     */
    public synchronized LocalWhisperUpstream.WindowRunner runnerFor(SttRunnerChoice choice) {
        if (!SpectroConfig.STT_RUNNER_SERVER.equals(choice.running()) || choice.binary() == null) {
            return cli;
        }
        if (server == null || !Objects.equals(serverBinary, choice.binary())) {
            if (server != null) {
                server.stop();
            }
            server = servers.apply(choice.binary());
            serverBinary = choice.binary();
        }
        return server;
    }

    /**
     * The resident server's state for the status page.
     *
     * @return down when no server was built
     */
    public synchronized WhisperServerRunner.Status serverStatus() {
        return server == null ? new WhisperServerRunner.Status(false, null) : server.status();
    }

    /** Stops the server when it has been idle for the idle time. */
    public void reap() {
        WhisperServerRunner current;
        synchronized (this) {
            current = server;
        }
        if (current != null) {
            current.reapIfIdle();
        }
    }

    /** Stops the server. */
    public void stopAll() {
        WhisperServerRunner current;
        synchronized (this) {
            current = server;
        }
        if (current != null) {
            current.stop();
        }
    }
}
