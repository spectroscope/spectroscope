package dev.spectroscope.core.skills;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;

/**
 * Card 247: slash-invoked skills inside a prompt. {@code tokens} finds the
 * candidates by shape; {@code expand} appends the bodies of the candidates a
 * resolver actually knows. The prompt the USER wrote is never rewritten —
 * expansion only ever appends, so the record stays the record.
 */
class SkillInvocationsTest {

    private static Function<String, Optional<Skill>> catalog(Map<String, String> bodies) {
        return name -> Optional.ofNullable(bodies.get(name))
                .map(body -> new Skill(name, "d", body, null));
    }

    @Test
    void findsTokensAtStartMidSentenceAndInPacks() {
        assertEquals(List.of("humanizer"), SkillInvocations.tokens("/humanizer fix this"));
        assertEquals(List.of("writing-plans", "brainstorming"),
                SkillInvocations.tokens("review this /writing-plans /brainstorming please"));
        assertEquals(List.of("superpowers:test-driven-development"),
                SkillInvocations.tokens("do it /superpowers:test-driven-development"));
    }

    @Test
    void punctuationEndsATokenWithoutJoiningIt() {
        assertEquals(List.of("humanizer"), SkillInvocations.tokens("run /humanizer, then stop"));
        assertEquals(List.of("humanizer"), SkillInvocations.tokens("(/humanizer)"));
    }

    @Test
    void aSlashInsideAWordOrPathIsNoInvocation() {
        // "/tmp" opens the path, but "x" after the second slash is glued to it.
        assertEquals(List.of("tmp"), SkillInvocations.tokens("look at /tmp/x"));
        assertEquals(List.of(), SkillInvocations.tokens("3/4 of the time"));
        assertEquals(List.of(), SkillInvocations.tokens("a/b"));
        assertEquals(List.of(), SkillInvocations.tokens("no slash here"));
    }

    @Test
    void expandAppendsTheKnownBodiesInOrder() {
        var resolver = catalog(Map.of("plan", "PLAN BODY", "brain", "BRAIN BODY"));
        String out = SkillInvocations.expand("go /plan /brain now", resolver);
        assertEquals("""
                go /plan /brain now

                [skill: plan]
                PLAN BODY

                [skill: brain]
                BRAIN BODY""", out);
    }

    @Test
    void unknownTokensLeaveThePromptExactlyAsItWas() {
        var resolver = catalog(Map.of());
        String prompt = "look at /tmp/x and /nothing";
        assertSame(prompt, SkillInvocations.expand(prompt, resolver));
    }

    @Test
    void aRepeatedTokenExpandsOnce() {
        var resolver = catalog(Map.of("plan", "PLAN BODY"));
        String out = SkillInvocations.expand("/plan then /plan again", resolver);
        assertEquals("""
                /plan then /plan again

                [skill: plan]
                PLAN BODY""", out);
    }
}
