package dev.spectroscope.core.permission;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The tier map, card 199's answer to a question the protocol cannot answer.
 *
 * <p>Both MCP transports pin revision {@code 2024-11-05}, and that revision has
 * no tool annotations at all — {@code readOnlyHint} and its siblings arrived in
 * {@code 2025-03-26}. So a tier can never be read off a server's own
 * declaration, and every test below is really one assertion in three shapes:
 * the PRODUCT decides the tier, and everything it has not decided is
 * eval-execute.
 */
class ToolTierMapTest {

    @Test
    void theShippedMapNamesItsSchemaAndItsVersion() {
        ToolTierMap map = ToolTierMap.shipped();
        assertEquals(1, map.schemaVersion(), "the shipped map declares schema version 1");
        assertNotNull(map.mapVersion());
        assertTrue(map.mapVersion().matches("\\d{4}-\\d{2}-\\d{2}(\\.\\d+)?"),
                "the map version is a dated release marker, was: " + map.mapVersion());
    }

    @Test
    void aBuiltInReaderResolvesToRead() {
        assertEquals(ToolTier.READ, ToolTierMap.shipped().resolve("read_file").tier());
        assertEquals(ToolTier.READ, ToolTierMap.shipped().resolve("grep").tier());
    }

    @Test
    void aBuiltInWriterResolvesToWrite() {
        assertEquals(ToolTier.WRITE, ToolTierMap.shipped().resolve("write_file").tier());
        assertEquals(ToolTier.WRITE, ToolTierMap.shipped().resolve("edit_file").tier());
    }

    @Test
    void runCommandResolvesToEvalExecute() {
        assertEquals(ToolTier.EVAL_EXECUTE, ToolTierMap.shipped().resolve("run_command").tier());
    }

    @Test
    void spawningAnAgentIsEvalExecuteBecauseTheChildCanRunCommands() {
        assertEquals(ToolTier.EVAL_EXECUTE, ToolTierMap.shipped().resolve("spawn_agent").tier());
        assertEquals(ToolTier.EVAL_EXECUTE, ToolTierMap.shipped().resolve("spawn_agents").tier());
    }

    @Test
    void aBuiltInToolTheMapDoesNotListFallsToEvalExecute() {
        ToolTierMap.Resolution resolution = ToolTierMap.shipped().resolve("some_tool_shipped_later");
        assertEquals(ToolTier.EVAL_EXECUTE, resolution.tier());
        assertEquals("unmapped", resolution.source());
    }

    @Test
    void aToolOfAServerTheMapDoesNotKnowFallsToEvalExecute() {
        ToolTierMap.Resolution resolution =
                ToolTierMap.shipped().resolve("mcp__some_unblessed_server__read_page");
        assertEquals(ToolTier.EVAL_EXECUTE, resolution.tier());
        assertEquals("unmapped", resolution.source(),
                "an unknown server rates none of its tools — the map does");
    }

    @Test
    void anUnlistedToolOfAKnownServerFallsToEvalExecuteToo() {
        ToolTierMap map = ToolTierMap.shipped();
        assertEquals(ToolTier.READ, map.resolve("mcp__spectro-notes__search_notes").tier(),
                "the in-house notes server is blessed, and its reader is a reader");
        assertEquals(ToolTier.EVAL_EXECUTE,
                map.resolve("mcp__spectro-notes__a_tool_added_after_this_release").tier(),
                "a server that grows a tool prompts for it until the next map release");
    }

    @Test
    void theNodeContextEvalTheStressTestNamedIsRatedEvalExecute() {
        assertEquals(ToolTier.EVAL_EXECUTE,
                ToolTierMap.shipped().resolve("mcp__playwright__browser_run_code_unsafe").tier());
    }

    @Test
    void aWireHintMayRaiseAToolAboveItsMappedTier() {
        ToolTierMap map = ToolTierMap.shipped();
        assertEquals(ToolTier.EVAL_EXECUTE,
                map.resolve("read_file", ToolTier.EVAL_EXECUTE).tier(),
                "a hint that widens is honoured");
    }

    @Test
    void aWireHintNeverLowersAToolBelowItsMappedTier() {
        ToolTierMap map = ToolTierMap.shipped();
        assertEquals(ToolTier.EVAL_EXECUTE, map.resolve("run_command", ToolTier.READ).tier(),
                "a server does not get to rate its own tool below the prompt");
        assertEquals(ToolTier.EVAL_EXECUTE,
                map.resolve("mcp__some_unblessed_server__anything", ToolTier.READ).tier(),
                "and a hint never creates a tier for a tool the map omits");
    }

    @Test
    void theResolutionCarriesTheMapVersionSoAnAuditLineCanNameIt() {
        ToolTierMap map = ToolTierMap.shipped();
        assertEquals(map.mapVersion(), map.resolve("read_file").mapVersion());
    }

    @Test
    void everyBuiltInToolTheProductRegistersIsRatedInTheShippedMap() {
        // The fallback is safe (an unrated tool is eval-execute and prompts) but
        // it is not FREE: a tool that ships unrated turns a working read entry
        // into a prompt on the day it lands, and nobody would connect the two.
        // So the map is pinned to the belt rather than to somebody's memory.
        ToolTierMap map = ToolTierMap.shipped();
        java.util.List<String> unrated = dev.spectroscope.core.tools.StandardTools.all().stream()
                .map(dev.spectroscope.core.tools.Tool::name)
                .filter(name -> "unmapped".equals(map.resolve(name).source()))
                .toList();
        assertTrue(unrated.isEmpty(),
                "these built-in tools ship without a tier and will prompt for everything: "
                        + unrated + " — add them to resources/permission/tool-tiers.json "
                        + "and bump mapVersion");
    }

    @Test
    void theOtherRegisteredBuiltInsAreRatedToo() {
        // The belt is not the whole registry: web_fetch, web_search, browse_page,
        // generate_image, update_plan, use_skill, report_status and the two spawn
        // tools are registered by the faces, not by StandardTools.all().
        ToolTierMap map = ToolTierMap.shipped();
        for (String name : java.util.List.of("web_fetch", "web_search", "browse_page",
                "generate_image", "update_plan", "use_skill", "read_skill_file", "report_status",
                "spawn_agent", "spawn_agents", "ask_user_question")) {
            assertNotEquals("unmapped", map.resolve(name).source(), name + " ships unrated");
        }
    }
}
