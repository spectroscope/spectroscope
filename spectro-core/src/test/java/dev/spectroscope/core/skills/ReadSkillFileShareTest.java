package dev.spectroscope.core.skills;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool;
import dev.spectroscope.core.tools.Tool.ToolContext;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Review of card 493: {@code read_skill_file} judges a whole read against the
 * run's read share, the way {@code read_file} does, and its description in a
 * run names that share. At the shipped 25 it reads and describes itself as
 * v0.14.4 did.
 *
 * <p>The numbers: a window of 10,000 tokens admits 2,500 tokens at 25 % and
 * 1,000 at 10 %, which is 7,500 and 3,000 bytes at 3 bytes per token. A file
 * of 5,000 bytes sits between the two.</p>
 */
class ReadSkillFileShareTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int WINDOW = 10_000;

    /** The v0.14.4 description, copied from {@code SkillLibrary} at {@code 8d7fcf48}. */
    private static final String V0144_DESCRIPTION = "Reads one file that ships beside a skill, whole"
            + " when it fits 25 % of your context window: the skill's name plus a path relative to"
            + " the skill's own directory, which use_skill names. Use it for the files a skill body"
            + " refers to \u2014 it reads them wherever the skill was installed, which read_file"
            + " cannot do when that is outside the working directory.";

    @TempDir
    Path tempDir;

    private Tool tool() throws IOException {
        Path dir = Files.createDirectories(tempDir.resolve("skills").resolve("notes"));
        Files.writeString(dir.resolve("SKILL.md"), "---\nname: notes\ndescription: d\n---\nbody");
        StringBuilder text = new StringBuilder();
        while (text.length() < 5_000) {
            text.append("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123\n");
        }
        Files.writeString(dir.resolve("mid.md"), text.substring(0, 5_000));
        return SkillLibrary.load(List.of(tempDir.resolve("skills"))).readSkillFileTool();
    }

    private ToolContext context(int share) throws IOException {
        Path cwd = Files.createDirectories(tempDir.resolve("workspace"));
        return new ToolContext(cwd, new CancelSignal(), "main", "c1", event -> { },
                attachment -> { }, change -> { }, millis -> { }, false, WINDOW, share);
    }

    private static ObjectNode input() {
        return JSON.createObjectNode().put("skill", "notes").put("path", "mid.md");
    }

    @Test
    void atTenPercentASiblingThatFitsTwentyFiveIsRefused() throws IOException {
        Tool tool = tool();
        String atDefault = tool.execute(input(), context(25));
        assertFalse(atDefault.startsWith("ERROR"), "premise: 25 % admits the file: " + atDefault);
        assertFalse(tool.execute(input(), context(0)).startsWith("ERROR"), "0 is the shipped share");
        String atTen = tool.execute(input(), context(10));
        assertTrue(atTen.startsWith("ERROR: file too large to read at once"), atTen);
        assertTrue(atTen.contains("one read may take 10 % of the 10000 tokens context window, 1000 tokens"),
                atTen);
    }

    @Test
    void theDescriptionOfARunNamesItsShareAndTheShippedOneIsV0144() throws IOException {
        Tool tool = tool();
        assertEquals(V0144_DESCRIPTION, tool.description());
        assertEquals(V0144_DESCRIPTION, tool.descriptionForRun(new Tool.RunFacts(25)));
        assertEquals(V0144_DESCRIPTION, tool.descriptionForRun(new Tool.RunFacts(0)));
        assertEquals(V0144_DESCRIPTION.replace("fits 25 %", "fits 10 %"),
                tool.descriptionForRun(new Tool.RunFacts(10)));
    }
}
