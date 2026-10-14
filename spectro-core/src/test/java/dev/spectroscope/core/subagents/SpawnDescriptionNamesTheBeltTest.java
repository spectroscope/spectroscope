package dev.spectroscope.core.subagents;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 601: the text the main agent reads about an explore child names the
 * tools that child is really handed, read from the same set the belt is built
 * from. A main agent told "read-only (list_dir, read_file, glob, grep)" ran the
 * code graph itself while its explore child was offered the tool on every turn.
 */
class SpawnDescriptionNamesTheBeltTest {

    private static final String GRAPH_NOTE = "code_graph when the folder has a code graph";

    private static Set<String> withAnInventedTool(Set<String> names) {
        Set<String> wider = new LinkedHashSet<>(names);
        wider.add("invented_reader");
        return wider;
    }

    @Test
    void bothSpawnDescriptionsNameEveryExploreToolAndWhenTheGraphIsOffered() {
        assertTrue(RoleCatalog.EXPLORE_TOOL_NAMES.contains("code_graph"),
                "premise: an explore child keeps code_graph (card 547)");
        String one = RoleCatalog.spawnAgentDescription(SessionCount.UNSET);
        String many = RoleCatalog.spawnAgentsDescription(SessionCount.UNSET);
        for (String tool : RoleCatalog.EXPLORE_TOOL_NAMES) {
            assertTrue(one.contains(tool), "spawn_agent leaves out " + tool + ": " + one);
            assertTrue(many.contains(tool), "spawn_agents leaves out " + tool + ": " + many);
        }
        assertTrue(one.contains(GRAPH_NOTE), one);
        assertTrue(many.contains(GRAPH_NOTE), many);
    }

    @Test
    void aFurtherToolInTheSetChangesBothDescriptions() {
        Set<String> wider = withAnInventedTool(RoleCatalog.EXPLORE_TOOL_NAMES);
        assertFalse(RoleCatalog.spawnAgentDescription(RoleCatalog.EXPLORE_TOOL_NAMES, SessionCount.UNSET)
                .contains("invented_reader"), "premise: the real set has no such tool");
        assertTrue(RoleCatalog.spawnAgentDescription(wider, SessionCount.UNSET).contains("invented_reader"),
                RoleCatalog.spawnAgentDescription(wider, SessionCount.UNSET));
        assertTrue(RoleCatalog.spawnAgentsDescription(wider, SessionCount.UNSET).contains("invented_reader"),
                RoleCatalog.spawnAgentsDescription(wider, SessionCount.UNSET));
    }

    @Test
    void theShippedDescriptionsAreTheOnesDerivedFromTheRealSet() {
        assertEquals(RoleCatalog.spawnAgentDescription(RoleCatalog.EXPLORE_TOOL_NAMES, SessionCount.of(3)),
                RoleCatalog.spawnAgentDescription(SessionCount.of(3)));
        assertEquals(RoleCatalog.spawnAgentsDescription(RoleCatalog.EXPLORE_TOOL_NAMES, SessionCount.of(3)),
                RoleCatalog.spawnAgentsDescription(SessionCount.of(3)));
    }

    @Test
    void theResearchPromptNamesItsReadersAndItsWebToolsFromTheirSets() {
        String shipped = RoleCatalog.SYSTEM_PROMPTS.get(AgentType.RESEARCH);
        assertEquals(RoleCatalog.researchSystemPrompt(RoleCatalog.RESEARCH_READ_TOOL_NAMES,
                RoleCatalog.WEB_TOOL_NAMES), shipped);
        Set<String> wider = withAnInventedTool(RoleCatalog.RESEARCH_READ_TOOL_NAMES);
        assertTrue(RoleCatalog.researchSystemPrompt(wider, RoleCatalog.WEB_TOOL_NAMES).contains("invented_reader"));
        assertTrue(RoleCatalog.researchSystemPrompt(RoleCatalog.RESEARCH_READ_TOOL_NAMES,
                List.of("web_search", "invented_fetcher")).contains("invented_fetcher"));
        assertFalse(shipped.contains("code_graph"), "the research role keeps its belt (card 547)");
    }

    @Test
    void theSystemContextViewReadsTheSameText() {
        RoleCatalog.ToolSummary shown = RoleCatalog.parentTools().get(0);
        assertEquals("spawn_agent", shown.name());
        assertTrue(shown.description().contains(GRAPH_NOTE), shown.description());
    }
}
