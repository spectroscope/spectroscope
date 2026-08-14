package dev.spectroscope.server.settings;

import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 207: the research skill ships in the product's namespaced catalog — the
 * {@code spectroscope} pack inside the bundled skills, seeded on first boot and
 * advertised as {@code spectroscope:research} by the card-182 pack rule. This
 * test reads the SHIPPED resource, not the repo file, so what it pins is what
 * every artifact actually carries.
 *
 * <p>It also pins the port honestly: the skill is an adaptation for spectro's
 * own tools (web_search, web_fetch, browse_page), not a copy of a Claude Code
 * skill — the Claude Code tool spellings and any operator path must not ride
 * into the public artifact.
 */
class ResearchSkillTest {

    private static String shippedBody() throws IOException {
        Resource resource = new PathMatchingResourcePatternResolver()
                .getResource("classpath:bundled-skills/spectroscope/research/SKILL.md");
        assertTrue(resource.isReadable(),
                "the research skill must ride the artifact as bundled-skills/spectroscope/research/SKILL.md");
        try (InputStream in = resource.getInputStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void theSkillParsesWithItsBareNameSoThePackRuleNamespacesIt() throws IOException {
        Skill skill = SkillLibrary.parse(shippedBody(), "research", Path.of("research/SKILL.md"));
        // The frontmatter name stays bare: the FOLDER supplies the namespace
        // (card 182 applies <pack>:<name> to the key), so a renamed pack would
        // follow the directory instead of fighting it.
        assertEquals("research", skill.name());
        assertFalse(skill.description().isBlank(), "the catalog bullet needs a description");
    }

    @Test
    void theSkillSpeaksSpectroToolsNotClaudeCodeTools() throws IOException {
        String body = shippedBody();
        for (String tool : new String[] {"web_search", "web_fetch", "browse_page"}) {
            assertTrue(body.contains(tool), "the skill must teach spectro's own tool: " + tool);
        }
        // The owner's research-kit declares Claude Code's WebSearch/WebFetch and
        // an Artifact tool — none of which exist here. Their spellings staying
        // out is what makes this a port rather than a copy.
        assertFalse(body.contains("WebSearch"), "Claude Code tool spelling must not ride along");
        assertFalse(body.contains("WebFetch"), "Claude Code tool spelling must not ride along");
        assertFalse(body.contains("Artifact"), "there is no Artifact tool in this product");
    }

    @Test
    void theSkillCarriesTheShapeOfTheMethod() throws IOException {
        String body = shippedBody();
        // The three depth modes and the escalation ladder survive the port.
        for (String mode : new String[] {"quick", "normal", "deep"}) {
            assertTrue(body.contains("`" + mode + "`"), "depth mode must survive the port: " + mode);
        }
        assertTrue(body.contains("escalation"), "the escalation ladder is the heart of the method");
        // Honest source tiers: primary / practitioner / unverified.
        for (String tier : new String[] {"[P]", "[B]", "[U]"}) {
            assertTrue(body.contains(tier), "source-quality tier must survive the port: " + tier);
        }
        assertTrue(body.contains("user's language"),
                "answering in the user's language is behavior, not decoration");
    }

    @Test
    void nothingPrivateRidesIntoThePublicArtifact() throws IOException {
        String body = shippedBody();
        assertFalse(body.contains("/Users/"), "no home path may ship in a public artifact");
        assertFalse(body.contains("research-kit"),
                "the owner's private skill is the model, not a reference the product may name");
    }
}
