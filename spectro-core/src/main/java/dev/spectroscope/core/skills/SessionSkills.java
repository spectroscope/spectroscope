package dev.spectroscope.core.skills;

import com.fasterxml.jackson.databind.JsonNode;
import dev.spectroscope.core.tools.Tool;

import java.nio.file.Path;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * Card 558: the skill tools of one session over the catalogue the session
 * holds now. The session swaps the catalogue at the start of a run, when its
 * playbook pick may have changed, and every tool here reads the current one at
 * call time; the agent is never rebuilt for it.
 *
 * <p>The listing of the catalogue (one bullet per skill and command) rides in
 * the system prompt as the per-run line of the parent's {@code use_skill}
 * ({@link Tool#systemPromptLine()}, read once when a run starts), so a pick
 * changes the listing at the next turn and never inside one. A child gets the
 * same two tools without the listing, as it had before this card. While the
 * catalogue holds nothing, neither tool is offered.
 *
 * <p>Reads only: both tools hand over text that is already loaded or read one
 * file beside a skill, as {@link SkillLibrary} does.
 */
public final class SessionSkills {

    private volatile SessionCatalogue current = SessionCatalogue.of(List.of());

    private final Tool useSkill = new Delegate(true, true);
    private final Tool readSkillFile = new Delegate(false, false);
    private final List<Tool> childTools = List.of(new Delegate(true, false), new Delegate(false, false));

    /**
     * Holds the catalogue the next tool call and the next run read.
     *
     * @param catalogue the session's catalogue now
     */
    public void set(SessionCatalogue catalogue) {
        current = Objects.requireNonNull(catalogue, "catalogue");
    }

    /** @return the catalogue the session holds now */
    public SessionCatalogue current() {
        return current;
    }

    /**
     * The lookup a {@code /name} in a prompt expands through.
     *
     * @param name an effective name
     * @return the skill or command, or empty
     */
    public Optional<Skill> find(String name) {
        return current.library().find(name);
    }

    /** @return the parent's {@code use_skill}, which carries the listing */
    public Tool useSkillTool() {
        return useSkill;
    }

    /** @return the parent's {@code read_skill_file} */
    public Tool readSkillFileTool() {
        return readSkillFile;
    }

    /** @return {@code use_skill} and {@code read_skill_file} for a child belt, without the listing */
    public List<Tool> childTools() {
        return childTools;
    }

    /** One skill tool that asks the current catalogue's library for its answer. */
    private final class Delegate implements Tool {

        private final boolean use;
        private final boolean lists;

        private Delegate(boolean use, boolean lists) {
            this.use = use;
            this.lists = lists;
        }

        private Tool now() {
            SkillLibrary library = current.library();
            return use ? library.useSkillTool() : library.readSkillFileTool();
        }

        @Override
        public String name() {
            return use ? "use_skill" : "read_skill_file";
        }

        @Override
        public String description() {
            return now().description();
        }

        @Override
        public String descriptionForRun(RunFacts run) {
            return now().descriptionForRun(run);
        }

        @Override
        public JsonNode inputSchema() {
            return now().inputSchema();
        }

        /** Read-only, like the library's own tools. */
        @Override
        public boolean needsPermission() {
            return false;
        }

        /** Offered while the catalogue holds a skill or a command. */
        @Override
        public boolean offeredIn(Path cwd) {
            return !current.library().skills().isEmpty();
        }

        /** The parent's {@code use_skill} carries the listing; every other instance none. */
        @Override
        public String systemPromptLine() {
            if (!lists) {
                return null;
            }
            String section = current.library().systemPromptSection();
            return section.isBlank() ? null : section.strip();
        }

        @Override
        public String execute(JsonNode input, ToolContext context) {
            return now().execute(input, context);
        }
    }
}
