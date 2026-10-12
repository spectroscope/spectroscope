package dev.spectroscope.server.llm;

import dev.spectroscope.core.config.SttRunnerChoice;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 528: one resident whisper-server per spectro process, handed to every
 * session that runs the server, reaped when idle and stopped on shutdown.
 */
class SpeechRunnersTest {

    @TempDir
    Path temp;

    private final List<String> binaries = new ArrayList<>();
    private final List<Boolean> alive = new ArrayList<>();
    private final AtomicLong now = new AtomicLong(0);

    private final LocalWhisperUpstream.WindowRunner cli = (wav, language) -> Optional.of("cli");

    private SpeechRunners runners() {
        return new SpeechRunners(binary -> {
            binaries.add(binary);
            int index = alive.size();
            alive.add(false);
            WhisperServerRunner.Launcher launcher = (argv, log) -> {
                alive.set(index, true);
                return new WhisperServerRunner.Child() {
                    @Override
                    public boolean isAlive() {
                        return alive.get(index);
                    }

                    @Override
                    public void stop() {
                        alive.set(index, false);
                    }
                };
            };
            WhisperServerRunner.Http http = new WhisperServerRunner.Http() {
                @Override
                public int health(int port) {
                    return 200;
                }

                @Override
                public WhisperServerRunner.Answer inference(int port, byte[] wav, String language,
                        long timeoutMs) {
                    return new WhisperServerRunner.Answer(200, "{\"text\":\"\"}");
                }
            };
            return new WhisperServerRunner(Path.of(binary), () -> Path.of("/m/ggml-small.bin"), launcher, http,
                    () -> 50_000, now::get, ms -> now.addAndGet(ms), temp, 20_000, 1_000);
        }, cli);
    }

    private static SttRunnerChoice server(String binary) {
        return new SttRunnerChoice("auto", "server", false, binary);
    }

    private Path silence() throws Exception {
        Path wav = temp.resolve("s.wav");
        Files.write(wav, LocalWhisperUpstream.wav(new byte[32_000]));
        return wav;
    }

    @Test
    void everySessionOnTheServerGetsTheOneResidentServer() {
        SpeechRunners runners = runners();

        LocalWhisperUpstream.WindowRunner first = runners.runnerFor(server("/opt/homebrew/bin/whisper-server"));
        LocalWhisperUpstream.WindowRunner second = runners.runnerFor(server("/opt/homebrew/bin/whisper-server"));

        assertSame(first, second);
        assertEquals("whisper-server", first.engine());
        assertEquals(1, binaries.size());
    }

    @Test
    void aSessionOnTheCliGetsTheCliRunner() {
        SpeechRunners runners = runners();

        LocalWhisperUpstream.WindowRunner runner =
                runners.runnerFor(new SttRunnerChoice("cli", "cli", false, "/opt/homebrew/bin/whisper-cli"));

        assertSame(cli, runner);
        assertTrue(binaries.isEmpty(), "no server is built for a cli session");
    }

    @Test
    void anotherBinaryReplacesTheServerAndStopsTheOldOne() throws Exception {
        SpeechRunners runners = runners();
        runners.runnerFor(server("/a/whisper-server")).warmUp(silence(), "en");
        assertTrue(alive.get(0));

        LocalWhisperUpstream.WindowRunner next = runners.runnerFor(server("/b/whisper-server"));

        assertFalse(alive.get(0), "the old server stopped");
        assertNotSame(null, next);
        assertEquals(List.of("/a/whisper-server", "/b/whisper-server"), binaries);
    }

    @Test
    void theStatusIsDownUntilAServerIsUp() throws Exception {
        SpeechRunners runners = runners();
        assertFalse(runners.serverStatus().up());

        runners.runnerFor(server("/a/whisper-server")).warmUp(silence(), "en");

        assertTrue(runners.serverStatus().up());
        assertEquals(50_000, runners.serverStatus().port());
    }

    @Test
    void reapStopsAnIdleServer() throws Exception {
        SpeechRunners runners = runners();
        runners.runnerFor(server("/a/whisper-server")).warmUp(silence(), "en");

        now.addAndGet(1_000);
        runners.reap();

        assertFalse(alive.get(0));
    }

    @Test
    void stopAllStopsTheServerForShutdown() throws Exception {
        SpeechRunners runners = runners();
        runners.runnerFor(server("/a/whisper-server")).warmUp(silence(), "en");

        runners.stopAll();

        assertFalse(alive.get(0));
        assertFalse(runners.serverStatus().up());
    }
}
