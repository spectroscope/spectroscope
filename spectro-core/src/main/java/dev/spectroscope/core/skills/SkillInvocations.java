package dev.spectroscope.core.skills;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Slash-invoked skills inside a user prompt (card 247): {@code /humanizer},
 * {@code /superpowers:test-driven-development} — several per message, anywhere
 * in the text. {@link #tokens} finds the candidates by shape; {@link #expand}
 * appends the bodies of those a resolver actually knows, so the model receives
 * the skill's real instructions while the prompt itself — the transcript, the
 * user's own bubble — stays the literal text the user wrote.
 *
 * <p>A candidate is a slash at the start of the text or after a non-word,
 * non-slash character, followed by a name. {@code /tmp/x} yields only
 * {@code tmp} (the second slash is glued to a word), {@code 3/4} yields
 * nothing — and an unknown candidate simply stays prose, which is the whole
 * refusal story: nothing is ever rewritten or dropped.
 */
public final class SkillInvocations {

    /** Start of text, or one character that is not a letter, digit or slash,
     *  then the slash and a name in the skill charset (packs use a colon). */
    private static final Pattern TOKEN =
            Pattern.compile("(?:^|[^\\p{L}\\p{N}/])/([\\p{L}\\p{N}][\\p{L}\\p{N}_:-]*)");

    private SkillInvocations() {}

    /**
     * Every slash-token candidate in the prompt, in reading order, duplicates
     * kept — resolution and dedup are {@link #expand}'s job.
     *
     * @param prompt the user's text
     * @return the candidate names, without their slashes
     */
    public static List<String> tokens(String prompt) {
        List<String> names = new ArrayList<>();
        Matcher m = TOKEN.matcher(prompt);
        while (m.find()) {
            names.add(m.group(1));
        }
        return names;
    }

    /**
     * The prompt as the MODEL should read it: the literal text, then one
     * appended block per resolved token ({@code [skill: name]} plus the body),
     * first mention wins, repeats expand once. When no token resolves, the
     * very same string instance comes back — the caller can cheaply see that
     * nothing changed.
     *
     * @param prompt   the user's text, returned untouched inside the result
     * @param resolver looks a candidate name up in the installed catalog
     * @return the expanded prompt, or {@code prompt} itself when nothing resolved
     */
    public static String expand(String prompt, Function<String, Optional<Skill>> resolver) {
        List<String> names = tokens(prompt);
        if (names.isEmpty()) {
            return prompt;
        }
        StringBuilder out = new StringBuilder(prompt);
        Set<String> seen = new LinkedHashSet<>();
        boolean resolved = false;
        for (String name : names) {
            if (!seen.add(name)) {
                continue;
            }
            Optional<Skill> skill = resolver.apply(name);
            if (skill.isEmpty()) {
                continue;
            }
            out.append("\n\n[skill: ").append(name).append("]\n").append(skill.get().body());
            resolved = true;
        }
        return resolved ? out.toString() : prompt;
    }
}
