package dev.spectroscope.cli;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import picocli.CommandLine;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * The global --provider/--model/--base-url flags must reach every entry point:
 * the REPL resolves them since day one, but the run and doctor subcommands used
 * to load Overrides.none() — a headless run silently ignored the flags and the
 * documented precedence (flags > env > settings > config > defaults) broke.
 */
class CliOverridesTest {

    @Test
    void globalFlagsBecomeOverrides() {
        SpectroCli cli = new SpectroCli();
        new CommandLine(cli).parseArgs(
                "--provider", "ollama", "--model", "m1", "--base-url", "http://localhost:9999",
                "--workspace", "/tmp/agent-desk");

        SpectroConfig.Overrides overrides = cli.cliOverrides();

        assertEquals("ollama", overrides.provider());
        assertEquals("m1", overrides.model());
        assertEquals("http://localhost:9999", overrides.baseUrl());
        assertEquals("/tmp/agent-desk", overrides.workspace());
        assertNull(overrides.permissionMode());
    }

    @Test
    void runSubcommandSeesTheParentFlags() {
        SpectroCli cli = new SpectroCli();
        CommandLine.ParseResult parsed = new CommandLine(cli).parseArgs(
                "--base-url", "http://localhost:9999", "run", "-p", "hi");

        RunCommand run = (RunCommand) parsed.subcommand().commandSpec().userObject();

        assertEquals("http://localhost:9999", run.effectiveOverrides().baseUrl());
    }

    @Test
    void standaloneRunCommandFallsBackToNoOverrides() {
        RunCommand run = new RunCommand();
        new CommandLine(run).parseArgs("-p", "hi");

        assertNull(run.effectiveOverrides().baseUrl());
        assertNull(run.effectiveOverrides().provider());
    }
}
