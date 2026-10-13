package dev.spectroscope.core.codegraph;

import dev.spectroscope.core.skills.SessionCatalogue;
import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.tools.CodeGraphTool;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 587, criterion 5: the app ships a skill named {@code code-graph} that
 * tells the model what the graph tool answers, when to call it before reading
 * files, and how to phrase a question. It rides as the app's own source in the
 * session catalogue.
 */
class CodeGraphSkillTest {

    private static final String TOOL = new CodeGraphTool().name();

    @Test
    void theSkillIsReadFromTheJarUnderItsName() {
        Skill skill = CodeGraphSkill.skill();
        assertEquals("code-graph", skill.name());
        assertEquals(CodeGraphSkill.NAME, skill.name());
        assertFalse(skill.description().isBlank());
        assertFalse(skill.description().contains("\n"), "the listing line is one line");
        assertNull(skill.source(), "a skill from the jar has no folder to point at");
    }

    @Test
    void theBodyNamesTheToolAndEveryActionItHas() {
        String body = CodeGraphSkill.skill().body();
        assertTrue(body.contains("`" + TOOL + "`"), "the body names the tool");
        for (String action : CodeGraphTool.ACTIONS) {
            assertTrue(body.contains("`" + action + "`"), "the body names the action " + action);
        }
        assertTrue(body.contains("before"), "it says when to call the tool: before reading files");
        assertTrue(body.contains("/graph update"), "it names how a stale graph is refreshed");
        // Fix round, M7: every range the skill names is the tool's own.
        assertTrue(body.contains("`budget` (" + CodeGraphTool.MIN_BUDGET + " to " + CodeGraphTool.MAX_BUDGET
                + " tokens)"), "the budget range the skill names is the tool's own");
        assertTrue(body.contains("`depth` (" + CodeGraphTool.MIN_DEPTH + " to " + CodeGraphTool.MAX_DEPTH + ")"),
                "the depth range the skill names is the tool's own");
        assertTrue(body.contains("`top` (" + CodeGraphTool.MIN_TOP + " to " + CodeGraphTool.MAX_TOP + ")"),
                "the top range the skill names is the tool's own");
    }

    @Test
    void theTextIsPlainEnglishWithoutDashes() {
        Skill skill = CodeGraphSkill.skill();
        for (String text : List.of(skill.description(), skill.body())) {
            assertFalse(text.matches("(?s).*[\\u2013\\u2014].*"), "an em or en dash: " + text);
            assertFalse(text.matches("(?s).*[äöüßÄÖÜ].*"), "German in an English skill");
        }
    }

    @Test
    void theLayerIsTheAppsOwnSourceWithTheOneSkill() {
        SessionCatalogue.Layer layer = CodeGraphSkill.layer();
        assertEquals(SessionCatalogue.APP, layer.source());
        assertEquals(SessionCatalogue.APP, layer.namespace());
        assertEquals(1, layer.entries().size());
        SessionCatalogue.Entry entry = layer.entries().get(0);
        assertEquals(SessionCatalogue.SKILL, entry.kind());
        assertEquals("code-graph", entry.plain());
        assertEquals(CodeGraphSkill.skill().body(), entry.body());
    }
}
