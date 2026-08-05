package dev.spectroscope.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * The two fleet switches, settable from the UI (owner ask 2026-08-05: "sonst
 * verlieren wir viele leute die env zu finden").
 *
 * <p>The allowlist is the security boundary, not a convenience. That file is
 * read by the launchers into the process environment, so an unrestricted writer
 * would be remote code execution wearing a settings form.</p>
 */
class OperatorSettingsTest {

    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new SessionsController()).build();

    private static String json(String name, String value) {
        return "{\"name\":\"" + name + "\",\"value\":\"" + value + "\"}";
    }

    @Test
    void aNameThatIsNotOnTheListIsRefused() throws Exception {
        // The one that matters: ~/.spectro/.env is loaded into the environment
        // by the launchers, so this line would run arbitrary code at next boot.
        for (String name : new String[] {
            "JAVA_TOOL_OPTIONS", "PATH", "SPECTRO_NODE_CMD", "ANTHROPIC_API_KEY", "", "spring.datasource.url"
        }) {
            mvc.perform(post("http://127.0.0.1/api/settings/env")
                            .contentType("application/json")
                            .content(json(name, "anything")))
                    .andExpect(status().isBadRequest());
        }
    }

    @Test
    void aPortMustBeAPort() throws Exception {
        for (String bad : new String[] {"70000", "-1", "eight", "80 80", "8080; rm -rf /"}) {
            mvc.perform(post("http://127.0.0.1/api/settings/env")
                            .contentType("application/json")
                            .content(json("SPECTRO_HUB_PORT", bad)))
                    .andExpect(status().isBadRequest());
        }
    }

    @Test
    void theSpawnSwitchTakesOnlyTheTwoWords() throws Exception {
        for (String bad : new String[] {"yes", "1", "TRUE ish", "on"}) {
            mvc.perform(post("http://127.0.0.1/api/settings/env")
                            .contentType("application/json")
                            .content(json("SPECTRO_ALLOW_SPAWN", bad)))
                    .andExpect(status().isBadRequest());
        }
    }

    @Test
    void aReboundHostSavesNothing() throws Exception {
        // Arming process spawning is exactly what a cross-site page must never
        // reach. The UI's confirmation is a courtesy; this is the control.
        mvc.perform(post("http://evil.example/api/settings/env")
                        .contentType("application/json")
                        .content(json("SPECTRO_ALLOW_SPAWN", "true")))
                .andExpect(status().isNotFound());
    }

    @Test
    void aCrossSiteOriginSavesNothing() throws Exception {
        mvc.perform(post("http://127.0.0.1/api/settings/env")
                        .header("Origin", "https://evil.example")
                        .contentType("application/json")
                        .content(json("SPECTRO_HUB_PORT", "8744")))
                .andExpect(status().isNotFound());
    }

    @Test
    void savingSaysPlainlyThatItIsNotInForceYet() throws Exception {
        // The beans that read these are built at boot. Reporting "saved" alone
        // would let the operator believe the hub came up.
        mvc.perform(post("http://127.0.0.1/api/settings/env")
                        .contentType("application/json")
                        .content(json("SPECTRO_HUB_PORT", "0")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.restartRequired").value(true));
    }
}

/** The file half: what the boot actually lifts out of ~/.spectro/.env. */
class DotEnvSettingsTest {

    @TempDir
    Path home;

    private Path envWith(String body) throws Exception {
        Path f = home.resolve(".env");
        Files.writeString(f, body);
        return f;
    }

    @Test
    void readsOnlyTheTwoNamesItMaySee() throws Exception {
        // The same file holds API keys. Lifting whatever it contains into
        // Spring's environment would put secrets into every property
        // resolution, every error page and every actuator surface.
        Path f = envWith("""
                ANTHROPIC_API_KEY=sk-secret
                SPECTRO_HUB_PORT=8744
                JAVA_TOOL_OPTIONS=-javaagent:/tmp/evil.jar
                SPECTRO_ALLOW_SPAWN=true
                """);
        Map<String, Object> read = DotEnvSettings.read(f);
        assertEquals(Map.of("SPECTRO_HUB_PORT", "8744", "SPECTRO_ALLOW_SPAWN", "true"), read);
    }

    @Test
    void skipsCommentsBlanksAndLinesThatAreNotAssignments() throws Exception {
        Path f = envWith("""

                # SPECTRO_HUB_PORT=9999
                SPECTRO_HUB_PORT=8744
                =nonsense
                just-a-word
                """);
        assertEquals(Map.of("SPECTRO_HUB_PORT", "8744"), DotEnvSettings.read(f));
    }

    @Test
    void lastWins_becauseTheWriterAppends() throws Exception {
        Path f = envWith("SPECTRO_HUB_PORT=1\nSPECTRO_HUB_PORT=8744\n");
        assertEquals("8744", DotEnvSettings.read(f).get("SPECTRO_HUB_PORT"));
    }

    @Test
    void anAbsentFileIsSimplyOff() {
        assertEquals(Map.of(), DotEnvSettings.read(home.resolve("nope.env")));
    }

    @Test
    void theFileNeverOverridesTheRealEnvironment() throws Exception {
        // Appended LAST: what the operator started the process with wins for
        // the life of that process.
        MockEnvironment env = new MockEnvironment();
        env.setProperty("SPECTRO_HUB_PORT", "9999");
        env.getPropertySources().addLast(
                new org.springframework.core.env.MapPropertySource(
                        DotEnvSettings.SOURCE, Map.of("SPECTRO_HUB_PORT", "8744")));
        assertEquals("9999", env.getProperty("SPECTRO_HUB_PORT"));
    }
}
