package dev.spectroscope.core.subagents;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 547: the main agent's prompt names {@code code_graph} with one line,
 * an explore and a worker child keep the tool, and a research child does not.
 */
class CodeGraphRoleTest {

    @Test
    void anExploreChildKeepsCodeGraph() {
        assertTrue(RoleCatalog.beltPolicy(AgentType.EXPLORE).holds("code_graph"));
    }

    @Test
    void theExplorePromptNamesCodeGraph() {
        assertTrue(RoleCatalog.SYSTEM_PROMPTS.get(AgentType.EXPLORE).contains("(code_graph)"),
                RoleCatalog.SYSTEM_PROMPTS.get(AgentType.EXPLORE));
    }

    @Test
    void theMainPromptTellsTheModelToAskTheGraphBeforeReadingManyFiles() {
        String line = "If your tools include `code_graph`, ask it a question about structure "
                + "(callers, paths, what a change affects) before you read many files to answer it.";
        assertTrue(RoleCatalog.CODE_GRAPH_GUIDANCE.equals(line), RoleCatalog.CODE_GRAPH_GUIDANCE);
        assertTrue(new dev.spectroscope.core.tools.CodeGraphTool().systemPromptLine().equals(line));
        // The loop adds it to a run that offers the tool; the base prompt
        // keeps the bytes of v0.14.4 (AgentOffersOnlyPresentToolsTest).
        assertFalse(RoleCatalog.BASE_SYSTEM_PROMPT.contains("code_graph"), RoleCatalog.BASE_SYSTEM_PROMPT);
    }

    @Test
    void aWorkerChildHoldsCodeGraphLikeEveryOtherBeltTool() {
        assertTrue(RoleCatalog.beltPolicy(AgentType.WORKER).holds("code_graph"));
        assertFalse(RoleCatalog.WORKER_WITHHOLDS.contains("code_graph"));
    }

    @Test
    void aResearchChildReadsTheFilesAndTheWebButNotTheCodeGraph() {
        RoleCatalog.BeltPolicy research = RoleCatalog.beltPolicy(AgentType.RESEARCH);
        assertTrue(research.holds("grep") && research.holds("read_file") && research.holds("use_skill"),
                "test premise: the research child reads the workspace");
        assertFalse(research.holds("code_graph"), "the research role is the web reader, card 547 keeps it as it was");
        assertFalse(RoleCatalog.SYSTEM_PROMPTS.get(AgentType.RESEARCH).contains("code_graph"));
    }
}
