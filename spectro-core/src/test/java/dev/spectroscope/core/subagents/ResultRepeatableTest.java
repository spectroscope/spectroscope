package dev.spectroscope.core.subagents;

import dev.spectroscope.core.image.GenerateImageTool;
import dev.spectroscope.core.image.ImageStore;
import dev.spectroscope.core.tools.AskUserQuestionTool;
import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 467: which tools can give an earlier result back when called again.
 *
 * <p>The loop stubs an old, large result with a sentence that tells the model
 * to call the tool again. That sentence is true for a read and false for a
 * tool whose second call does new work: a child agent, a question to a person,
 * a new picture. Those answer false, and their results always travel whole.</p>
 */
class ResultRepeatableTest {

    @TempDir
    Path dir;

    private static SubagentManager manager() {
        return new SubagentManager(SubagentConfig.builder()
                .cwd(Path.of("."))
                .parentAgentId("main")
                .onPermission(request -> true)
                .baseTools(List.of())
                .build());
    }

    @Test
    void everyStandardToolCanBeCalledAgainForItsResult() {
        // The positive half: the reads and the shell, whose outputs the card
        // was written about, keep the default.
        List<Tool> standard = StandardTools.all();
        assertFalse(standard.isEmpty());
        for (Tool tool : standard) {
            assertTrue(tool.resultRepeatable(), tool.name() + " lost the default");
        }
        assertTrue(standard.stream().anyMatch(tool -> "read_file".equals(tool.name())));
        assertTrue(standard.stream().anyMatch(tool -> "run_command".equals(tool.name())));
    }

    @Test
    void aSpawnToolStartsANewChildRatherThanFetchingTheOldReport() {
        for (Tool tool : manager().tools()) {
            assertFalse(tool.resultRepeatable(), tool.name() + " claims a second call fetches"
                    + " the first child's report");
        }
    }

    @Test
    void aRoleToolStartsANewChildRatherThanFetchingTheOldReport() {
        List<Tool> roles = manager().devTools();
        assertFalse(roles.isEmpty());
        for (Tool tool : roles) {
            assertFalse(tool.resultRepeatable(), tool.name() + " claims a second call fetches"
                    + " the first child's report");
        }
    }

    @Test
    void aQuestionAskedAgainIsANewQuestion() {
        assertFalse(new AskUserQuestionTool(request -> null).resultRepeatable());
    }

    @Test
    void aSecondImageCallDrawsANewImage() {
        assertFalse(new GenerateImageTool(() -> null, new ImageStore(dir)).resultRepeatable());
    }
}
