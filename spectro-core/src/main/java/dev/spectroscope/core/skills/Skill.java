package dev.spectroscope.core.skills;

import java.nio.file.Path;

/**
 * One installed skill: a folder with a SKILL.md. Name and description are cheap
 * metadata that always enter the system prompt; the body carries the full
 * instructions and is only handed to the model on demand (progressive disclosure).
 *
 * @param name        unique key, from the frontmatter or the folder name
 * @param description one-liner shown in the system prompt's skill list
 * @param body        the markdown instructions after the frontmatter fence
 * @param source      the SKILL.md this skill was loaded from
 */
public record Skill(String name, String description, String body, Path source) {}
