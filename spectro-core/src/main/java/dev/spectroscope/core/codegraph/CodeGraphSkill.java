package dev.spectroscope.core.codegraph;

import dev.spectroscope.core.skills.SessionCatalogue;
import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Card 587, criterion 5: the skill the app ships for the code graph. It says
 * what the {@code code_graph} tool answers, when to call it before reading
 * files and how to phrase a question. It is read from the jar, never seeded
 * into the user's folder, and a session holds it as the app's own source
 * while its folder has a graph.
 */
public final class CodeGraphSkill {

    /** The skill's name, as the model calls it with {@code use_skill}. */
    public static final String NAME = "code-graph";

    /** Where the text sits on the classpath. */
    static final String RESOURCE = "/app-skills/code-graph/SKILL.md";

    private static final Skill SKILL = load();

    private CodeGraphSkill() {
    }

    /** @return the skill, without a folder: it lives in the jar */
    public static Skill skill() {
        return SKILL;
    }

    /** @return the app's layer of a session catalogue, holding this one skill */
    public static SessionCatalogue.Layer layer() {
        return new SessionCatalogue.Layer(SessionCatalogue.APP, SessionCatalogue.APP, List.of(
                new SessionCatalogue.Entry(SessionCatalogue.SKILL, SKILL.name(), SKILL.description(), SKILL.body(),
                        null, null)));
    }

    private static Skill load() {
        try (InputStream in = CodeGraphSkill.class.getResourceAsStream(RESOURCE)) {
            if (in == null) {
                throw new IllegalStateException(RESOURCE + " is missing from the jar");
            }
            return SkillLibrary.parse(new String(in.readAllBytes(), StandardCharsets.UTF_8), NAME, null);
        } catch (IOException e) {
            throw new UncheckedIOException("cannot read " + RESOURCE, e);
        }
    }
}
