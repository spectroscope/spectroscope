package dev.spectroscope.cli;

import dev.spectroscope.core.mcp.McpServerConfig;
import org.junit.jupiter.api.Test;
import picocli.CommandLine;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 220, the CLI-flag half of the owner's combined road: {@code spectro run}
 * grows {@code --mcp} / {@code --no-mcp}, an explicit flag overrides the
 * {@code headlessMcp} settings key for that one invocation, and an absent flag
 * leaves the decision to the settings. The spec insisted the flag is a
 * permission-shaped decision and must not wear a convenience-shaped name — the
 * help text says what it approves, in tool terms.
 */
class RunCommandMcpFlagTest {

    @Test
    void theFlagIsThreeStateAndAbsentMeansTheSettingsDecide() {
        RunCommand plain = new RunCommand();
        new CommandLine(plain).parseArgs("-p", "hi");
        assertNull(plain.mcpFlag(),
                "no flag typed means null — the settings key decides, not a hardcoded default");

        RunCommand granted = new RunCommand();
        new CommandLine(granted).parseArgs("-p", "hi", "--mcp");
        assertEquals(Boolean.TRUE, granted.mcpFlag(), "--mcp is the operator asking by name");

        RunCommand declined = new RunCommand();
        new CommandLine(declined).parseArgs("-p", "hi", "--no-mcp");
        assertEquals(Boolean.FALSE, declined.mcpFlag(),
                "--no-mcp declines even a settings file that consented");
    }

    @Test
    void theHelpTextIsPermissionShapedNotConvenienceShaped() {
        String usage = new CommandLine(new RunCommand()).getUsageMessage();
        assertTrue(usage.contains("approves every tool every configured server offers"),
                "the flag's help must state what --permissions auto approves after the"
                        + " mount, in tool terms — got:\n" + usage);
        assertTrue(usage.contains("unwatched"),
                "and it must say nobody is watching, because that is what headless means"
                        + " — got:\n" + usage);
        assertTrue(usage.contains("headlessMcp"),
                "the help names the settings key the flag overrides — got:\n" + usage);
    }

    @Test
    void anExplicitMcpOverNoConfiguredServersWarnsInsteadOfStayingSilent() {
        // Spec §4.1: silence would let a typo in the settings path look like a
        // working mount, and the run's stderr is the only place a cron line's
        // operator ever looks.
        String warning = RunCommand.emptyMcpWarning(Boolean.TRUE, List.of());
        assertTrue(warning != null && warning.contains("--mcp")
                        && warning.contains("no MCP servers configured"),
                "the explicit flag over an empty block warns by name, got: " + warning);

        assertNull(RunCommand.emptyMcpWarning(Boolean.TRUE,
                        List.of(new McpServerConfig("notes", "/bin/echo", List.of(), null, null, null))),
                "with servers configured there is nothing to warn about");
        assertNull(RunCommand.emptyMcpWarning(null, List.of()),
                "no flag, no warning — the settings-only path stays quiet");
        assertNull(RunCommand.emptyMcpWarning(Boolean.FALSE, List.of()),
                "--no-mcp over an empty block is consistent, not a mistake");
    }
}
