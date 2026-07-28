package dev.spectroscope.cli;

import org.junit.jupiter.api.Test;
import picocli.CommandLine;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 72 on the command surface: the three trigger flags parse, and every
 * fence refusal happens BEFORE config, network or provider are touched —
 * exit 1 with the reason on stderr, exactly like the other flag validations.
 */
class NodeTriggerFlagsTest {

    @Test
    void theTriggerFlagsParseThroughTheCli() {
        SpectroCli cli = new SpectroCli();
        CommandLine.ParseResult parsed = new CommandLine(cli).parseArgs(
                "node", "-p", "scan", "--hub", "127.0.0.1:7331", "--context", "fleet-1",
                "--watch", "/tmp/drop", "--listen", "8300", "--every", "5m");

        NodeCommand node = (NodeCommand) parsed.subcommand().commandSpec().userObject();
        assertEquals("/tmp/drop", node.watch);
        assertEquals("8300", node.listen);
        assertEquals("5m", node.every);
    }

    private static String executeExpectingRefusal(String... args) {
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        PrintStream original = System.err;
        System.setErr(new PrintStream(captured, true, StandardCharsets.UTF_8));
        try {
            int exit = new CommandLine(new SpectroCli()).execute(args);
            assertEquals(1, exit, "a fence refusal is exit 1 with a reason, never a stack trace");
        } finally {
            System.setErr(original);
        }
        return captured.toString(StandardCharsets.UTF_8);
    }

    @Test
    void aHostInListenIsRefusedAtParseTime() {
        String err = executeExpectingRefusal(
                "node", "-p", "scan", "--context", "f", "--listen", "0.0.0.0:8300");
        assertTrue(err.contains("bare port"), "the refusal names the fence: " + err);
    }

    @Test
    void aMissingWatchDirectoryIsRefusedBeforeAnythingStarts() {
        String err = executeExpectingRefusal(
                "node", "-p", "scan", "--context", "f",
                "--watch", "/definitely/not/here/ever");
        assertTrue(err.contains("does not exist"), err);
    }

    @Test
    void aSubSecondEveryIsRefused() {
        String err = executeExpectingRefusal(
                "node", "-p", "scan", "--context", "f", "--every", "500ms");
        assertTrue(err.contains("at least 1s"), err);
    }
}
