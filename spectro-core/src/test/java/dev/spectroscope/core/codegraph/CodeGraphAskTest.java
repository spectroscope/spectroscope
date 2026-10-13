package dev.spectroscope.core.codegraph;

import dev.spectroscope.core.tools.CodeGraphTool;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 587, criterion 3: {@code /graph ask <question>} hands the model the
 * question with a line that asks it to answer through the graph tool, and is
 * refused with a reason where the tool would not be offered.
 */
class CodeGraphAskTest {

    private static final String TOOL = new CodeGraphTool().name();

    @Test
    void theModelReadsTheQuestionAndALineThatNamesTheGraphTool() {
        assertTrue(CodeGraphAsk.LINE.contains("`" + TOOL + "`"), CodeGraphAsk.LINE);
        assertEquals("who calls PlaybookRunner.step\n\n" + CodeGraphAsk.LINE,
                CodeGraphAsk.modelText("  who calls PlaybookRunner.step  "));
    }

    @Test
    void theRecordKeepsTheCommandAsTyped() {
        assertEquals("/graph ask who calls PlaybookRunner.step",
                CodeGraphAsk.recordText(" who calls PlaybookRunner.step "));
    }

    @Test
    void aReadyFolderIsNotRefused() {
        assertNull(CodeGraphAsk.refusal(CodeGraphTool.Availability.READY, CodeGraphBackend.GRAPHIFY));
    }

    @Test
    void everyOtherStateIsRefusedWithAReasonAndTheWayOn() {
        String noGraph = CodeGraphAsk.refusal(CodeGraphTool.Availability.NO_GRAPH, CodeGraphBackend.GRAPHIFY);
        assertTrue(noGraph.contains("/graph build"), noGraph);
        String missing = CodeGraphAsk.refusal(CodeGraphTool.Availability.NOT_INSTALLED, CodeGraphBackend.GRAPHIFY);
        assertTrue(missing.contains("graphify") && missing.contains("uv tool install graphifyy"), missing);
        assertTrue(missing.contains("/graph build"), missing);
        String outside = CodeGraphAsk.refusal(CodeGraphTool.Availability.OUTSIDE, CodeGraphBackend.GRAPHIFY);
        assertTrue(outside.contains("/graph build"), outside);
        String noFolder = CodeGraphAsk.refusal(CodeGraphTool.Availability.NO_FOLDER, CodeGraphBackend.GRAPHIFY);
        assertTrue(noFolder.contains("folder"), noFolder);
        CodeGraphBackend other = new CodeGraphBackend("othergraph", "og", "brew install og",
                Path.of("og", "g.json"), Path.of("og", "g.html"));
        String otherMissing = CodeGraphAsk.refusal(CodeGraphTool.Availability.NOT_INSTALLED, other);
        assertTrue(otherMissing.contains("othergraph") && otherMissing.contains("brew install og"), otherMissing);
        assertFalse(otherMissing.contains("graphify"), "the refusal names the backend the setting chose");
    }

    @Test
    void anEmptyQuestionIsAnsweredWithTheUsage() {
        assertTrue(CodeGraphAsk.USAGE.contains("/graph ask <question>"), CodeGraphAsk.USAGE);
    }

    @Test
    void noTextCarriesADash() {
        List<String> texts = new ArrayList<>(List.of(CodeGraphAsk.LINE, CodeGraphAsk.USAGE));
        for (CodeGraphTool.Availability a : CodeGraphTool.Availability.values()) {
            String refusal = CodeGraphAsk.refusal(a, CodeGraphBackend.GRAPHIFY);
            if (refusal != null) {
                texts.add(refusal);
            }
        }
        assertEquals(CodeGraphTool.Availability.values().length + 1, texts.size(), "every state but ready speaks");
        for (String text : texts) {
            assertFalse(text.matches("(?s).*[\\u2013\\u2014].*"), text);
        }
    }
}
