package dev.spectroscope.core.skills;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.tools.Tool;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 558, criteria 1 and 3: a session's skill tools read the catalogue the
 * session holds NOW, so a pick reaches the model and a withdrawn pick leaves
 * it, without rebuilding the agent. The listing rides in the system prompt
 * through the parent's per-run tool line; a child keeps the tools and gets no
 * listing, as before.
 */
class SessionSkillsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir Path dir;

    private Tool.ToolContext context() {
        return new Tool.ToolContext(dir, new CancelSignal());
    }

    private static ObjectNode named(String name) {
        return JSON.createObjectNode().put("name", name);
    }

    private static SessionCatalogue playbookWith(String id, String name, String body, Path skillFile) {
        return SessionCatalogue.of(List.of(new SessionCatalogue.Layer(SessionCatalogue.PLAYBOOK,
                SessionCatalogue.playbookNamespace(id), List.of(new SessionCatalogue.Entry(SessionCatalogue.SKILL,
                        name, "about " + name, body, skillFile, null)))));
    }

    @Test
    void useSkillReadsTheCatalogueTheSessionHoldsAtCallTime() {
        SessionSkills skills = new SessionSkills();
        skills.set(playbookWith("spectro", "brainstorming", "Ask one question at a time.", null));

        assertTrue(skills.useSkillTool().execute(named("brainstorming"), context())
                .contains("Ask one question at a time."));
        assertEquals("Ask one question at a time.", skills.find("brainstorming").orElseThrow().body());

        skills.set(SessionCatalogue.of(List.of()));

        assertTrue(skills.useSkillTool().execute(named("brainstorming"), context()).startsWith("ERROR:"));
        assertTrue(skills.find("brainstorming").isEmpty());
    }

    @Test
    void theToolsAreOfferedOnlyWhileTheCatalogueHoldsASkill() {
        SessionSkills skills = new SessionSkills();
        List<Tool> all = List.of(skills.useSkillTool(), skills.readSkillFileTool(),
                skills.childTools().get(0), skills.childTools().get(1));
        assertEquals(List.of("use_skill", "read_skill_file", "use_skill", "read_skill_file"),
                all.stream().map(Tool::name).toList());
        all.forEach(t -> assertFalse(t.offeredIn(dir), t.name() + " offered with nothing to read"));

        skills.set(playbookWith("spectro", "x", "b", null));

        all.forEach(t -> assertTrue(t.offeredIn(dir), t.name() + " not offered with a skill to read"));
    }

    @Test
    void theParentsListingFollowsTheCatalogueAndAChildGetsNone() {
        SessionSkills skills = new SessionSkills();
        assertNull(skills.useSkillTool().systemPromptLine());

        SessionCatalogue c = playbookWith("spectro", "brainstorming", "b", null);
        skills.set(c);

        String line = skills.useSkillTool().systemPromptLine();
        assertEquals(c.library().systemPromptSection().strip(), line);
        assertTrue(line.contains("- brainstorming: about brainstorming"));
        assertNull(skills.readSkillFileTool().systemPromptLine());
        skills.childTools().forEach(t -> assertNull(t.systemPromptLine(), t.name() + " lists the catalogue to a child"));

        skills.set(SessionCatalogue.of(List.of()));
        assertNull(skills.useSkillTool().systemPromptLine());
    }

    @Test
    void readSkillFileReadsAFileBesideAPlaybookSkillInPlace() throws IOException {
        Path skillDir = Files.createDirectories(dir.resolve("playbook/skills/pack/tdd"));
        Files.writeString(skillDir.resolve("SKILL.md"), "---\nname: tdd\n---\nRead example.md.");
        Files.writeString(skillDir.resolve("example.md"), "red, then green");
        SessionSkills skills = new SessionSkills();
        skills.set(playbookWith("spectro", "tdd", "Read example.md.", skillDir.resolve("SKILL.md")));

        ObjectNode input = JSON.createObjectNode().put("skill", "tdd").put("path", "example.md");
        assertEquals("red, then green", skills.readSkillFileTool().execute(input, context()));
        assertEquals("red, then green", skills.childTools().get(1).execute(input, context()));
    }
}
