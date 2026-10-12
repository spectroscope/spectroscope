package dev.spectroscope.server.llm;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.IntSupplier;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * Live text on the local route with the speech model kept in memory (card 528).
 *
 * <p>whisper-cli loads the model in every process, so card 527's warm up costs a
 * model load on every press. This runner starts one {@code whisper-server} from
 * the same Homebrew package on the first press, on {@code 127.0.0.1} and a port
 * spectro picks, and sends every chunk to it as {@code POST /inference}. The
 * server keeps the model loaded until spectro stops or nothing has used it for
 * the idle time.</p>
 *
 * <p>Rules, each pinned by {@code WhisperServerRunnerTest}:</p>
 * <ul>
 *   <li>The server binds the loopback only, and the client dials the loopback.</li>
 *   <li>A warm up starts the server when it is not up, waits for {@code /health}
 *       within a bound, then sends the silent clip as a probe. A server that is
 *       up gets the probe alone. The wait holds no lock: {@code stop()} and the
 *       status answer during a start, a stop ends the start, and a second press
 *       waits for the same process instead of starting another.</li>
 *   <li>A chunk never starts a server. When the server died, the chunk fails
 *       with an error and the next press starts it once; a start that fails is
 *       not tried again in the same press.</li>
 *   <li>A request a live server does not answer (hung, or its port gone)
 *       stops that server, and so does a failed probe; the next press starts
 *       a new one. An answer such as 400 keeps it, and so does an interrupt
 *       (the session closed).</li>
 *   <li>Idle is no request in flight and none finished within the idle time.</li>
 *   <li>stdout and stderr go to {@code whisper-server.log} in the temp folder
 *       given; the audio travels in the request body and never reaches a file
 *       on the server's side ({@code --convert} is not passed).</li>
 * </ul>
 */
public final class WhisperServerRunner implements LocalWhisperUpstream.WindowRunner {

    /** A started whisper-server process. */
    public interface Child {
        /**
         * Whether the process still runs.
         *
         * @return true while it runs
         */
        boolean isAlive();

        /** End the process; returns once it is gone or was killed. */
        void stop();
    }

    /** Starts a process with its output in a log file. */
    @FunctionalInterface
    public interface Launcher {
        /**
         * Start the process.
         *
         * @param argv the command line
         * @param log where stdout and stderr go
         * @return the running child
         * @throws IOException when it could not be started
         */
        Child start(List<String> argv, Path log) throws IOException;
    }

    /**
     * One HTTP answer.
     *
     * @param status the status code
     * @param body the body as text
     */
    public record Answer(int status, String body) {}

    /** The HTTP leg to a server on the loopback. */
    public interface Http {
        /**
         * {@code GET /health}.
         *
         * @param port the server's port
         * @return the status code
         * @throws IOException when nothing answers
         */
        int health(int port) throws IOException;

        /**
         * {@code POST /inference} with the wav as the multipart field {@code file}.
         *
         * @param port the server's port
         * @param wav a 16 kHz mono PCM16 wav
         * @param language the {@code sttLanguage} setting
         * @param timeoutMs how long to wait for the answer
         * @return the answer
         * @throws IOException when nothing answers in time
         */
        Answer inference(int port, byte[] wav, String language, long timeoutMs) throws IOException;
    }

    /** Sleeps; a test advances its clock instead. */
    @FunctionalInterface
    public interface Sleeper {
        /**
         * Wait.
         *
         * @param ms how long
         * @throws InterruptedException when interrupted
         */
        void sleep(long ms) throws InterruptedException;
    }

    /**
     * What the status page and the doctor say about the server.
     *
     * @param up whether the process runs and answered its probe
     * @param port its loopback port while up, else null
     */
    public record Status(boolean up, Integer port) {}

    /** The one address the server binds and the client dials. */
    static final String LOOPBACK = "127.0.0.1";

    /** How long one chunk may take; the probe waits the start bound instead. */
    static final long REQUEST_TIMEOUT_MS = 60_000L;

    /** How often {@code /health} is asked while the server starts. */
    private static final long HEALTH_POLL_MS = 50L;

    private static final ObjectMapper JSON = new ObjectMapper();

    private final Path binary;
    private final Supplier<Path> model;
    private final Launcher launcher;
    private final Http http;
    private final IntSupplier ports;
    private final LongSupplier clock;
    private final Sleeper sleeper;
    private final Path logDir;
    private final long startTimeoutMs;
    private final long idleMs;

    private Child child;
    private int port;
    private Path runningModel;
    /** Whether the probe after the start answered; until then the server is not up. */
    private boolean probed;
    private int inFlight;
    private long lastUsed;

    /**
     * Seam for tests and the production factory.
     *
     * @param binary the whisper-server binary
     * @param model the model file, read on every warm up
     * @param launcher starts the process
     * @param http the HTTP leg
     * @param ports picks a free loopback port
     * @param clock milliseconds, for the start bound and the idle time
     * @param sleeper waits between two health polls
     * @param logDir the temp folder the log goes into
     * @param startTimeoutMs how long a start may take until health answers
     * @param idleMs how long the server stays up with nothing to do
     */
    public WhisperServerRunner(Path binary, Supplier<Path> model, Launcher launcher, Http http,
            IntSupplier ports, LongSupplier clock, Sleeper sleeper, Path logDir,
            long startTimeoutMs, long idleMs) {
        this.binary = binary;
        this.model = model;
        this.launcher = launcher;
        this.http = http;
        this.ports = ports;
        this.clock = clock;
        this.sleeper = sleeper;
        this.logDir = logDir;
        this.startTimeoutMs = startTimeoutMs;
        this.idleMs = idleMs;
    }

    /**
     * Production: real processes, the real loopback HTTP leg, the wall clock.
     *
     * @param binary the whisper-server binary
     * @param model the model file, read on every warm up
     * @param logDir the temp folder the log goes into
     * @param startTimeoutMs how long a start may take
     * @param idleMs the idle time
     * @return the runner
     */
    public static WhisperServerRunner production(Path binary, Supplier<Path> model, Path logDir,
            long startTimeoutMs, long idleMs) {
        return new WhisperServerRunner(binary, model, WhisperServerRunner::launch, loopbackHttp(),
                WhisperServerRunner::freeLoopbackPort, System::currentTimeMillis, Thread::sleep, logDir,
                startTimeoutMs, idleMs);
    }

    @Override
    public String engine() {
        return "whisper-server";
    }

    @Override
    public synchronized boolean loadsModel() {
        return !upWith(model.get());
    }

    /**
     * Card 528 criterion 2: the readiness check. Starts the server when it is
     * not up with the configured model (once, bounded), then sends the silent
     * clip as a probe.
     */
    @Override
    public void warmUp(Path silentWav, String language) throws IOException, InterruptedException {
        Child mine;
        int at;
        boolean starting;
        synchronized (this) {
            Path wanted = model.get();
            if (!runsWith(wanted)) {
                launch(wanted, language);
            }
            mine = child;
            at = port;
            starting = !probed;
            inFlight++;
        }
        try {
            if (starting) {
                // Outside the lock: stop(), status() and a second press stay free
                // while the model loads.
                awaitHealth(mine, at);
            }
            byte[] clip = Files.readAllBytes(silentWav);
            Answer probe;
            try {
                probe = http.inference(at, clip, language, startTimeoutMs);
            } catch (IOException failed) {
                throw failedOn(mine, failed);
            }
            if (probe.status() != 200) {
                // A server that cannot answer silence cannot answer speech either.
                throw failedOn(mine, new IOException("whisper-server answered the probe with " + probe.status()));
            }
            synchronized (this) {
                if (child == mine) {
                    probed = true;
                }
            }
        } finally {
            release();
        }
    }

    @Override
    public Optional<String> transcribe(Path wav, String language) throws IOException, InterruptedException {
        Child mine;
        int at;
        synchronized (this) {
            if (child == null || !child.isAlive() || !probed) {
                // A chunk never starts the server: the next press does.
                throw new IOException("whisper-server stopped; press the microphone again to restart it");
            }
            mine = child;
            at = port;
            inFlight++;
        }
        try {
            byte[] chunk = Files.readAllBytes(wav);
            Answer answer;
            try {
                answer = http.inference(at, chunk, language, REQUEST_TIMEOUT_MS);
            } catch (IOException failed) {
                throw failedOn(mine, failed);
            }
            if (answer.status() != 200) {
                // The server answered: the request was bad, the server stays.
                throw new IOException("whisper-server answered " + answer.status() + ": "
                        + answer.body().strip());
            }
            return textOf(answer.body());
        } finally {
            release();
        }
    }

    /** Stops the server when it has been idle for the idle time. Called every minute. */
    public synchronized void reapIfIdle() {
        if (child != null && inFlight == 0 && clock.getAsLong() - lastUsed >= idleMs) {
            stopChild();
        }
    }

    /** Stops the server: spectro is shutting down. */
    public synchronized void stop() {
        stopChild();
    }

    /**
     * Whether the server is up, and its port.
     *
     * @return the status
     */
    public synchronized Status status() {
        boolean up = child != null && child.isAlive() && probed;
        return new Status(up, up ? port : null);
    }

    private boolean upWith(Path wanted) {
        return runsWith(wanted) && probed;
    }

    /** A live child with this model, answering or still starting. */
    private boolean runsWith(Path wanted) {
        return child != null && child.isAlive() && Objects.equals(runningModel, wanted);
    }

    /** Starts the process. Called under the lock; the wait for health is not. */
    private void launch(Path wanted, String language) throws IOException {
        stopChild();
        int picked = ports.getAsInt();
        List<String> argv = new ArrayList<>(List.of(binary.toString(),
                "-m", wanted.toString(),
                "-l", language == null || language.isBlank() ? "auto" : language,
                "--host", LOOPBACK, "--port", String.valueOf(picked),
                "-nt"));
        Files.createDirectories(logDir);
        child = launcher.start(argv, logDir.resolve("whisper-server.log"));
        port = picked;
        runningModel = wanted;
        probed = false;
    }

    /** Polls {@code /health} of a starting child, bounded. Called without the lock. */
    private void awaitHealth(Child mine, int at) throws IOException, InterruptedException {
        long deadline = clock.getAsLong() + startTimeoutMs;
        while (true) {
            synchronized (this) {
                if (child != mine) {
                    throw new IOException("whisper-server stopped while it started");
                }
            }
            if (!mine.isAlive()) {
                forget(mine);
                throw new IOException("whisper-server exited while it started; see whisper-server.log in "
                        + logDir);
            }
            try {
                if (http.health(at) == 200) {
                    synchronized (this) {
                        lastUsed = clock.getAsLong();
                    }
                    return;
                }
            } catch (IOException notYet) {
                // Refused until the model is loaded and the port is bound.
            }
            if (clock.getAsLong() >= deadline) {
                forget(mine);
                throw new IOException("whisper-server did not start within " + startTimeoutMs + " ms");
            }
            sleeper.sleep(HEALTH_POLL_MS);
        }
    }

    /** Stops {@code mine} when it is still the current child. */
    private synchronized void forget(Child mine) {
        if (child == mine) {
            stopChild();
        }
    }

    /**
     * After a request to {@code mine} failed. A dead child is forgotten; a
     * live one that did not answer is stopped. Either way the next chunk fails
     * at once and the next press starts a new server. An interrupt means the
     * session closed, and the server stays.
     */
    private synchronized IOException failedOn(Child mine, IOException failed) {
        if (child != mine) {
            return new IOException("whisper-server stopped: " + failed.getMessage(), failed);
        }
        if (!mine.isAlive()) {
            child = null;
            probed = false;
            return new IOException("whisper-server stopped: " + failed.getMessage(), failed);
        }
        if (Thread.currentThread().isInterrupted()) {
            return failed;
        }
        stopChild();
        return new IOException("whisper-server did not answer and was stopped; press the microphone again to "
                + "restart it: " + failed.getMessage(), failed);
    }

    private synchronized void release() {
        inFlight--;
        lastUsed = clock.getAsLong();
    }

    private void stopChild() {
        if (child != null) {
            child.stop();
        }
        child = null;
        probed = false;
    }

    /**
     * whisper-server's {@code json} answer as the text a composer gets: lines
     * trimmed, marker lines such as {@code [BLANK_AUDIO]} dropped, joined by a
     * space. The same rules as whisper-cli's transcript in {@code Transcriber}.
     *
     * @param body {@code {"text": "..."}}
     * @return the text, empty for silence
     * @throws IOException when the body is not that shape
     */
    static Optional<String> textOf(String body) throws IOException {
        JsonNode read = JSON.readTree(body);
        if (read == null || !read.has("text")) {
            throw new IOException("whisper-server answered without text");
        }
        String joined = read.path("text").asText("").lines()
                .map(String::strip)
                .filter(line -> !line.isEmpty() && !line.matches("^[\\[(].*[\\])]$"))
                .reduce((a, b) -> a + " " + b)
                .orElse("")
                .strip();
        return joined.isEmpty() ? Optional.empty() : Optional.of(joined);
    }

    /**
     * A free port on the loopback, read from a socket bound to port 0 and
     * closed again.
     *
     * @return the port
     */
    static int freeLoopbackPort() {
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            socket.setReuseAddress(false);
            return socket.getLocalPort();
        } catch (IOException none) {
            throw new IllegalStateException("no free loopback port", none);
        }
    }

    /**
     * The production launcher: stdout and stderr into the log, replaced per
     * start, with the log's folder as the working folder.
     *
     * @param argv the command line
     * @param log where stdout and stderr go
     * @return the running child
     * @throws IOException when it could not be started
     */
    static Child launch(List<String> argv, Path log) throws IOException {
        Process process = new ProcessBuilder(argv)
                .directory(log.getParent().toFile())
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.to(log.toFile()))
                .start();
        return new Child() {
            @Override
            public boolean isAlive() {
                return process.isAlive();
            }

            @Override
            public void stop() {
                process.destroy();
                try {
                    if (!process.waitFor(3, TimeUnit.SECONDS)) {
                        process.destroyForcibly();
                        process.waitFor(3, TimeUnit.SECONDS);
                    }
                } catch (InterruptedException interrupted) {
                    process.destroyForcibly();
                    Thread.currentThread().interrupt();
                }
            }
        };
    }

    /**
     * The production HTTP leg: the JDK client to {@code 127.0.0.1}, no proxy.
     *
     * @return the leg
     */
    static Http loopbackHttp() {
        HttpClient client = HttpClient.newBuilder()
                .proxy(HttpClient.Builder.NO_PROXY)
                .connectTimeout(Duration.ofSeconds(2))
                .build();
        return new Http() {
            @Override
            public int health(int port) throws IOException {
                HttpRequest request = HttpRequest.newBuilder(URI.create("http://" + LOOPBACK + ":" + port + "/health"))
                        .timeout(Duration.ofSeconds(2)).GET().build();
                return send(client, request).status();
            }

            @Override
            public Answer inference(int port, byte[] wav, String language, long timeoutMs) throws IOException {
                String boundary = "spectro-" + UUID.randomUUID();
                HttpRequest request = HttpRequest.newBuilder(
                                URI.create("http://" + LOOPBACK + ":" + port + "/inference"))
                        .timeout(Duration.ofMillis(timeoutMs))
                        .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                        .POST(HttpRequest.BodyPublishers.ofByteArray(multipart(boundary, wav, language)))
                        .build();
                return send(client, request);
            }
        };
    }

    private static Answer send(HttpClient client, HttpRequest request) throws IOException {
        try {
            HttpResponse<String> response = client.send(request,
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            return new Answer(response.statusCode(), response.body());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted while whisper-server answered", interrupted);
        }
    }

    /**
     * The body of one inference request: the wav as the field {@code file}
     * under a fixed file name (no path of this machine travels), the language
     * and {@code response_format=json}.
     *
     * @param boundary the multipart boundary
     * @param wav the clip
     * @param language the {@code sttLanguage} setting
     * @return the body
     */
    static byte[] multipart(String boundary, byte[] wav, String language) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(wav.length + 512);
        String code = language == null || language.isBlank() ? "auto" : language;
        out.writeBytes(("--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"file\"; filename=\"chunk.wav\"\r\n"
                + "Content-Type: audio/wav\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.writeBytes(wav);
        out.writeBytes(("\r\n--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"language\"\r\n\r\n" + code + "\r\n"
                + "--" + boundary + "\r\n"
                + "Content-Disposition: form-data; name=\"response_format\"\r\n\r\njson\r\n"
                + "--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII));
        return out.toByteArray();
    }
}
