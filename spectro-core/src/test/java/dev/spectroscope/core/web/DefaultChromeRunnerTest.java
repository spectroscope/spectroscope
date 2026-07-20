package dev.spectroscope.core.web;

import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.util.List;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The production Chrome process runner against real (non-Chrome) processes:
 * argv exec with stdout/stderr captured SEPARATELY (the DOM must not be
 * polluted by Chrome's warnings), the kill-on-timeout path, and a spawn
 * failure as data instead of an exception. Chrome-free and portable —
 * /bin/echo and /bin/sh exist everywhere the suite runs.
 */
@Timeout(value = 20, unit = TimeUnit.SECONDS)
class DefaultChromeRunnerTest {

    private final DefaultChromeRunner runner = new DefaultChromeRunner();

    @Test
    void capturesStdoutAndStderrSeparately() {
        BrowsePageTool.ChromeRunner.Result result = runner.run(
                List.of("/bin/sh", "-c", "echo DOM; echo warning >&2"),
                10, new CancelSignal());

        assertEquals(0, result.exitCode());
        assertTrue(result.stdout().contains("DOM"), "stdout captured, got: " + result.stdout());
        assertFalse(result.stdout().contains("warning"), "stderr NOT merged into stdout");
        assertTrue(result.stderr().contains("warning"), "stderr captured, got: " + result.stderr());
        assertFalse(result.timedOut());
        assertNull(result.failure());
    }

    @Test
    void argvElementsAreNeverShellParsed() {
        // A URL-ish argument full of shell metacharacters must arrive verbatim.
        String hostile = "https://x.example/?a=1&b=$(whoami);'`\"";
        BrowsePageTool.ChromeRunner.Result result = runner.run(
                List.of("/bin/echo", hostile), 10, new CancelSignal());

        assertEquals(0, result.exitCode());
        assertTrue(result.stdout().contains(hostile), "verbatim argv, got: " + result.stdout());
    }

    @Test
    void killsTheProcessOnTimeout() {
        BrowsePageTool.ChromeRunner.Result result = runner.run(
                List.of("/bin/sleep", "30"), 1, new CancelSignal());

        assertTrue(result.timedOut());
    }

    @Test
    void aNonexistentBinaryIsAFailureNotAnException() {
        BrowsePageTool.ChromeRunner.Result result = runner.run(
                List.of("/no/such/binary-xyz"), 10, new CancelSignal());

        assertNotNull(result.failure(), "spawn failure reported as data");
        assertFalse(result.timedOut());
    }

    @Test
    void nonZeroExitCodesPassThrough() {
        BrowsePageTool.ChromeRunner.Result result = runner.run(
                List.of("/bin/sh", "-c", "exit 3"), 10, new CancelSignal());

        assertEquals(3, result.exitCode());
        assertNull(result.failure());
    }

    @Test
    void cancellationKillsTheProcess() throws InterruptedException {
        CancelSignal signal = new CancelSignal();
        Thread canceller = Thread.startVirtualThread(() -> {
            try {
                Thread.sleep(300);
            } catch (InterruptedException ignored) {
                return;
            }
            signal.cancel();
        });

        long start = System.nanoTime();
        runner.run(List.of("/bin/sleep", "30"), 25, signal);
        long elapsedMs = (System.nanoTime() - start) / 1_000_000;

        canceller.join();
        assertTrue(elapsedMs < 10_000, "cancel killed the child early, took " + elapsedMs + " ms");
    }
}
