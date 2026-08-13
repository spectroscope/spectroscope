package dev.spectroscope.core.mcp;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent.PermissionRequest;
import dev.spectroscope.core.permission.Allowlist;
import dev.spectroscope.core.permission.AllowlistMigration;
import dev.spectroscope.core.permission.ToolTier;
import dev.spectroscope.core.permission.ToolTierMap;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 199, criterion 1: the missing fence, demonstrated against a real test MCP
 * server rather than argued about.
 *
 * <p>The server offers exactly two tools — one that looks and one that runs code
 * in a Node context — and they arrive in the registry as {@code mcp__probe__*},
 * sharing a prefix, both declaring the same flat {@code needsPermission() ==
 * true}. Nothing on the wire tells them apart: the pinned MCP revision
 * {@code 2024-11-05} has no tool annotations, so both descriptors carry name,
 * description and inputSchema and nothing else.
 *
 * <p>{@link #twoExactNameEntriesApproveBothIdentically} records the hole that
 * stays open on purpose, and {@link #theOneEntryAnybodyWouldActuallyWriteNowSeparatesThem}
 * records the one that closes.
 */
class McpToolTierGateTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The read tool and the Node-context eval, as a server advertises them. */
    private static final String READER = "browser_read_page";
    private static final String EVAL = "browser_run_code_unsafe";

    /** The test server: one reader, one eval, both permission-gated, both nameless
     *  about what they do — which is every MCP server under revision 2024-11-05. */
    private static List<Tool> probeServerTools() {
        McpServerConfig probe =
                new McpServerConfig("playwright", "node", List.of("server.js"), null, null, null);
        Function<McpServerConfig, McpTransport> factory = cfg -> new FakeTransport(
                new McpInitializeResult("2024-11-05", cfg.name(), null),
                List.of(descriptor(READER), descriptor(EVAL)),
                (name, args) -> "ok");
        return McpServerRegistry.load(List.of(probe), Path.of("."), factory).tools();
    }

    private static McpToolDescriptor descriptor(String name) {
        return new McpToolDescriptor(name, name + " — what it does is prose, not a field",
                JSON.createObjectNode().put("type", "object"));
    }

    private static PermissionRequest call(String qualifiedName) {
        return new PermissionRequest("main", "c1", qualifiedName, JSON.createObjectNode(), 1L);
    }

    @Test
    void theServerItselfSaysNothingAboutWhatEitherToolDoes() {
        List<Tool> tools = probeServerTools();
        assertEquals(2, tools.size());
        assertEquals("mcp__playwright__" + READER, tools.get(0).name());
        assertEquals("mcp__playwright__" + EVAL, tools.get(1).name());
        assertTrue(tools.get(0).needsPermission());
        assertTrue(tools.get(1).needsPermission(),
                "one flat boolean each — the declaration cannot distinguish them");
        assertEquals(tools.get(0).needsPermission(), tools.get(1).needsPermission());
    }

    @Test
    void twoExactNameEntriesApproveBothIdentically() {
        // The hole card 199 leaves open with its eyes open: an exact name is an
        // exact name, and a pasted one is indistinguishable from a typed one.
        // Migration preserves this on purpose — turning it into a prompt storm
        // is what produces a blanket approval.
        Allowlist allowlist = Allowlist.fromEntries(
                AllowlistMigration.migrate(
                        List.of("mcp__playwright__" + READER, "mcp__playwright__" + EVAL),
                        ToolTierMap.shipped()).entries());
        assertTrue(allowlist.allows(call("mcp__playwright__" + READER)));
        assertTrue(allowlist.allows(call("mcp__playwright__" + EVAL)));
        assertEquals(allowlist.allows(call("mcp__playwright__" + READER)),
                allowlist.allows(call("mcp__playwright__" + EVAL)),
                "named one by one, both ride — what the settings page now SHOWS is the tier");
    }

    @Test
    void theOneEntryAnybodyWouldActuallyWriteNowSeparatesThem() {
        // 55 of 255 measured tool results carried gateWaitMs, and the owner's
        // transcripts show runs of up to 12 consecutive evals between
        // navigations. Nobody answers that by hand; they write one wildcard.
        // Before this card that wildcard matched nothing at all, so the only way
        // to stop the storm was to name every tool — including the eval.
        Allowlist nameOnlyWildcard = Allowlist.fromEntries(List.of("mcp__playwright__*"));
        assertFalse(nameOnlyWildcard.allows(call("mcp__playwright__" + READER)),
                "a wildcard that names no tier approves nothing");

        Allowlist readWildcard = Allowlist.fromEntries(List.of("mcp__playwright__*#read"));
        assertFalse(readWildcard.allows(call("mcp__playwright__" + EVAL)),
                "the Node-context eval still stops at the gate");
        assertFalse(readWildcard.allows(call("mcp__playwright__browser_snapshot")),
                "and so does a tool the shipped map does not list");

        Allowlist evalWildcard = Allowlist.fromEntries(List.of("mcp__playwright__*#eval-execute"));
        assertTrue(evalWildcard.allows(call("mcp__playwright__" + EVAL)),
                "an owner who writes eval-execute in full still gets it — deliberately, and visibly");
    }

    @Test
    void theGateNamesTheTierAndTheMapVersionForEitherVerdict() {
        Allowlist readWildcard = Allowlist.fromEntries(List.of("mcp__playwright__*#read"));
        Allowlist.Verdict refused = readWildcard.decide(call("mcp__playwright__" + EVAL));
        assertFalse(refused.approved());
        assertEquals(ToolTier.EVAL_EXECUTE, refused.toolTier());
        assertEquals(ToolTierMap.shipped().mapVersion(), refused.mapVersion());
    }
}
