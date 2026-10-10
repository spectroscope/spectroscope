package dev.spectroscope.core.playbook.run;

/**
 * @param name   the skill name as the step names it
 * @param source playbook when read from the playbook folder, installed when from the user's skills
 * @param text   the SKILL.md body
 */
public record SkillBody(String name, String source, String text) {
}
