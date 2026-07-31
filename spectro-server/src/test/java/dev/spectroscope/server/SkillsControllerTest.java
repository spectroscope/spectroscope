package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The settings skill manager (card 90): list both roots incl. disabled, flip
 *  the marker, delete user-root skills only — all behind the full fence. */
class SkillsControllerTest {

    @TempDir
    Path dir;

    private Path userRoot;
    private Path projectRoot;

    private SkillsController controller() throws IOException {
        userRoot = dir.resolve("user");
        projectRoot = dir.resolve("project");
        write(userRoot, "verification", "---\ndescription: check before claiming\n---\nbody");
        write(projectRoot, "brainstorming", "---\ndescription: explore first\n---\nbody");
        return new SkillsController(userRoot, projectRoot);
    }

    private static void write(Path root, String name, String content) throws IOException {
        Files.createDirectories(root.resolve(name));
        Files.writeString(root.resolve(name).resolve("SKILL.md"), content);
    }

    private static MockHttpServletRequest local() {
        return new MockHttpServletRequest();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> skills(SkillsController c, MockHttpServletRequest req) {
        return (List<Map<String, Object>>) c.list(req).getBody().get("skills");
    }

    @Test
    void listsBothRootsWithSourceAndDisabledState() throws IOException {
        SkillsController c = controller();
        Files.writeString(userRoot.resolve("verification").resolve(".disabled"), "");
        List<Map<String, Object>> rows = skills(c, local());
        assertEquals(2, rows.size());
        Map<String, Object> brainstorming = rows.get(0);
        assertEquals("brainstorming", brainstorming.get("name"));
        assertEquals("project", brainstorming.get("source"));
        assertEquals(false, brainstorming.get("disabled"));
        Map<String, Object> verification = rows.get(1);
        assertEquals("user", verification.get("source"));
        assertEquals(true, verification.get("disabled"));
        assertEquals("check before claiming", verification.get("description"));
    }

    @Test
    void togglesTheDisabledMarker() throws IOException {
        SkillsController c = controller();
        c.setDisabled("verification", Map.of("disabled", true), local());
        assertTrue(Files.exists(userRoot.resolve("verification/.disabled")));
        c.setDisabled("verification", Map.of("disabled", false), local());
        assertFalse(Files.exists(userRoot.resolve("verification/.disabled")));
    }

    @Test
    void deletesAUserSkillButRefusesAProjectSkill() throws IOException {
        SkillsController c = controller();
        assertEquals(200, c.delete("verification", local()).getStatusCode().value());
        assertFalse(Files.exists(userRoot.resolve("verification")));
        assertEquals(409, c.delete("brainstorming", local()).getStatusCode().value());
        assertTrue(Files.exists(projectRoot.resolve("brainstorming")));
    }

    @Test
    void refusesPathTraversalInTheName() throws IOException {
        SkillsController c = controller();
        Files.writeString(dir.resolve("outside.txt"), "precious");
        assertEquals(404, c.delete("../outside.txt", local()).getStatusCode().value());
        assertTrue(Files.exists(dir.resolve("outside.txt")));
    }

    @Test
    void theFullFenceGuardsEveryRoute() throws IOException {
        SkillsController c = controller();
        MockHttpServletRequest rebound = local();
        rebound.setServerName("attacker.example");
        assertEquals(404, c.list(rebound).getStatusCode().value());
        MockHttpServletRequest crossSite = local();
        crossSite.addHeader("Origin", "https://evil.example");
        assertEquals(404, c.setDisabled("verification", Map.of("disabled", true), crossSite)
                .getStatusCode().value());
        MockHttpServletRequest remote = local();
        remote.setRemoteAddr("203.0.113.7");
        assertEquals(404, c.delete("verification", remote).getStatusCode().value());
        assertTrue(Files.exists(userRoot.resolve("verification")), "nothing happened");
    }
}
