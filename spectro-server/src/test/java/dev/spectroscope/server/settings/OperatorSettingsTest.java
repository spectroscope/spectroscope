package dev.spectroscope.server.settings;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.server.DotEnvSettings;
import dev.spectroscope.server.session.SessionsController;

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
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
        for (String bad : new String[] {"70000", "-1", "eight", "80 80", "8080; rm -rf /", "true"}) {
            mvc.perform(post("http://127.0.0.1/api/settings/env")
                            .contentType("application/json")
                            .content(json("SPECTRO_HUB_PORT", bad)))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.reason").value("not-a-port"));
        }
    }

    @Test
    void aHubPortUnder1024IsRefusedWithTheReason() throws Exception {
        // Card 585: the app saved SPECTRO_HUB_PORT=1 and the next start died.
        for (String admin : new String[] {"1", "80", "443", "1023"}) {
            mvc.perform(post("http://127.0.0.1/api/settings/env")
                            .contentType("application/json")
                            .content(json("SPECTRO_HUB_PORT", admin)))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.reason").value("under-1024"))
                    .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("1024")));
        }
    }

    @Test
    void aHubPortInTheAppsRangeOrOnTheServersPortIsRefusedWithTheReason() throws Exception {
        // Review D1: 8080 was savable, and the next start died on it.
        for (String reserved : new String[] {"8080", "8090", "8100"}) {
            mvc.perform(post("http://127.0.0.1/api/settings/env")
                            .contentType("application/json")
                            .content(json("SPECTRO_HUB_PORT", reserved)))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.reason").value("app-range"));
        }
        mvc.perform(post("http://127.0.0.1/api/settings/env")
                        .with(request -> {
                            request.setLocalPort(7790);
                            return request;
                        })
                        .contentType("application/json")
                        .content(json("SPECTRO_HUB_PORT", "7790")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.reason").value("server-port"));
    }

    @Test
    void theHubSwitchTakesEightWordsAndSavesTrueOrFalse() throws Exception {
        Path env = SpectroConfig.dotEnvPath();
        String original = Files.isRegularFile(env) ? Files.readString(env) : null;
        try {
            String[][] words = {{"true", "true"}, {"On", "true"}, {"YES", "true"}, {"1", "true"},
                    {"false", "false"}, {"OFF", "false"}, {"no", "false"}, {"0", "false"}};
            for (String[] word : words) {
                mvc.perform(post("http://127.0.0.1/api/settings/env")
                                .contentType("application/json")
                                .content(json("SPECTRO_HUB_ENABLED", word[0])))
                        .andExpect(status().isOk());
                assertEquals(word[1], DotEnvSettings.read(env).get("SPECTRO_HUB_ENABLED"),
                        word[0] + " is written as " + word[1]);
            }
            for (String bad : new String[] {"maybe", "2", "TRUE ish"}) {
                mvc.perform(post("http://127.0.0.1/api/settings/env")
                                .contentType("application/json")
                                .content(json("SPECTRO_HUB_ENABLED", bad)))
                        .andExpect(status().isBadRequest())
                        .andExpect(jsonPath("$.reason").value("not-a-switch"));
            }
        } finally {
            restore(env, original);
        }
    }

    @Test
    void savingKeepsEveryOtherLineAndAddsTheCommentedDefaults() throws Exception {
        // The file holds API keys: a save may add lines, never drop or rewrite one.
        Path env = SpectroConfig.dotEnvPath();
        String original = Files.isRegularFile(env) ? Files.readString(env) : null;
        try {
            Files.createDirectories(env.getParent());
            Files.writeString(env, "# my notes\nFIXTURE_585_KEY=keep-me\nFIXTURE_585_OTHER=a = b\n");
            mvc.perform(post("http://127.0.0.1/api/settings/env")
                            .contentType("application/json")
                            .content(json("SPECTRO_HUB_ENABLED", "true")))
                    .andExpect(status().isOk());
            assertEquals(List.of("# my notes", "FIXTURE_585_KEY=keep-me", "FIXTURE_585_OTHER=a = b",
                            "SPECTRO_HUB_ENABLED=true", "# SPECTRO_HUB_PORT=7700"),
                    Files.readAllLines(env));

            mvc.perform(post("http://127.0.0.1/api/settings/env")
                            .contentType("application/json")
                            .content(json("SPECTRO_HUB_PORT", "7744")))
                    .andExpect(status().isOk());
            assertEquals(List.of("# my notes", "FIXTURE_585_KEY=keep-me", "FIXTURE_585_OTHER=a = b",
                            "SPECTRO_HUB_ENABLED=true", "# SPECTRO_HUB_PORT=7700", "SPECTRO_HUB_PORT=7744"),
                    Files.readAllLines(env), "the default stays as a comment, nothing is added twice");
        } finally {
            restore(env, original);
        }
    }

    @Test
    void savingAKeyAlsoLeavesTheHubDefaultsAsComments() throws Exception {
        Path env = SpectroConfig.dotEnvPath();
        String original = Files.isRegularFile(env) ? Files.readString(env) : null;
        try {
            Files.createDirectories(env.getParent());
            Files.writeString(env, "FIXTURE_585_KEY=keep-me\n");
            mvc.perform(post("http://127.0.0.1/api/onboarding/key")
                            .contentType("application/json")
                            .content("{\"provider\":\"tavily\",\"key\":\"tvly-fixture-585\"}"))
                    .andExpect(status().isOk());
            List<String> lines = Files.readAllLines(env);
            assertEquals("FIXTURE_585_KEY=keep-me", lines.get(0));
            assertTrue(lines.contains("# SPECTRO_HUB_ENABLED=false"), lines.toString());
            assertTrue(lines.contains("# SPECTRO_HUB_PORT=7700"), lines.toString());
        } finally {
            restore(env, original);
        }
    }

    @Test
    void theSettingsReadSaysWhetherTheHubIsOnAndItsDefaultPort() throws Exception {
        // The owner's file: a port and no switch. The old opt-in still means on.
        Path env = SpectroConfig.dotEnvPath();
        String original = Files.isRegularFile(env) ? Files.readString(env) : null;
        try {
            Files.createDirectories(env.getParent());
            Files.writeString(env, "SPECTRO_HUB_PORT=1\n");
            mvc.perform(get("http://127.0.0.1/api/settings/env"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.SPECTRO_HUB_ENABLED.value").value(""))
                    .andExpect(jsonPath("$.SPECTRO_HUB_ENABLED.effective").value(true))
                    .andExpect(jsonPath("$.SPECTRO_HUB_PORT.value").value("1"))
                    .andExpect(jsonPath("$.SPECTRO_HUB_PORT.default").value("7700"));
            Files.writeString(env, "SPECTRO_HUB_PORT=1\nSPECTRO_HUB_ENABLED=false\n");
            mvc.perform(get("http://127.0.0.1/api/settings/env"))
                    .andExpect(jsonPath("$.SPECTRO_HUB_ENABLED.effective").value(false));
        } finally {
            restore(env, original);
        }
    }

    /** Puts the test home's file back the way the test found it. */
    private static void restore(Path env, String original) throws Exception {
        if (original == null) {
            Files.deleteIfExists(env);
        } else {
            Files.writeString(env, original);
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
    void readsOnlyTheNamesItMaySee() throws Exception {
        // The same file holds API keys. Lifting whatever it contains into
        // Spring's environment would put secrets into every property
        // resolution, every error page and every actuator surface.
        Path f = envWith("""
                ANTHROPIC_API_KEY=sk-secret
                SPECTRO_HUB_PORT=8744
                JAVA_TOOL_OPTIONS=-javaagent:/tmp/evil.jar
                SPECTRO_ALLOW_SPAWN=true
                SPECTRO_HUB_ENABLED=true
                """);
        Map<String, Object> read = DotEnvSettings.read(f);
        assertEquals(Map.of("SPECTRO_HUB_PORT", "8744", "SPECTRO_ALLOW_SPAWN", "true",
                "SPECTRO_HUB_ENABLED", "true"), read);
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

    @Test
    void theCommentedDefaultsAreAppendedAndNothingElseMoves() throws Exception {
        // No trailing newline on purpose: the last line must not be glued to a comment.
        String before = "A_KEY=1\n# a note\nB_KEY=two = three";
        Path f = envWith(before);
        DotEnvSettings.keepCommentedDefaults(f);
        String after = Files.readString(f);
        assertEquals(before + "\n# SPECTRO_HUB_ENABLED=false\n# SPECTRO_HUB_PORT=7700\n", after);
        DotEnvSettings.keepCommentedDefaults(f);
        assertEquals(after, Files.readString(f), "a second call adds nothing");
    }

    @Test
    void aSetOrAlreadyCommentedSettingGetsNoSecondLine() throws Exception {
        String before = "SPECTRO_HUB_PORT=7744\n#SPECTRO_HUB_ENABLED=true\n";
        Path f = envWith(before);
        DotEnvSettings.keepCommentedDefaults(f);
        assertEquals(before, Files.readString(f));
    }

    @Test
    void aBlankSettingCountsAsNotSet() throws Exception {
        Path f = envWith("SPECTRO_HUB_ENABLED=true\nSPECTRO_HUB_PORT=\n");
        DotEnvSettings.keepCommentedDefaults(f);
        assertEquals("SPECTRO_HUB_ENABLED=true\nSPECTRO_HUB_PORT=\n# SPECTRO_HUB_PORT=7700\n", Files.readString(f));
    }

    @Test
    void anAbsentFileIsNotCreatedJustForComments() throws Exception {
        Path f = home.resolve("absent.env");
        DotEnvSettings.keepCommentedDefaults(f);
        assertTrue(!Files.exists(f));
    }

    @Test
    void aNameWithSpacesAroundTheEqualsSignCountsAsSet() throws Exception {
        // Review N4: read() takes the name before the "=", stripped; so does this.
        String before = "SPECTRO_HUB_PORT = 7745\nSPECTRO_HUB_ENABLED =true\n";
        Path f = envWith(before);
        assertEquals("7745", String.valueOf(DotEnvSettings.read(f).get("SPECTRO_HUB_PORT")).strip());
        DotEnvSettings.keepCommentedDefaults(f);
        assertEquals(before, Files.readString(f));
    }

    @Test
    void twoSavesAtOnceLoseNoKeyAndDoubleNoComment() throws Exception {
        // Review D5: two requests at once, a port blur and a switch click. The
        // fake keys must survive every round, and each comment exists once.
        String keys = "ANTHROPIC_API_KEY=sk-ant-FAKE-test-value-0001\nOPENAI_API_KEY=\"quoted=with=equals\"\n";
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(2);
        int lost = 0;
        int doubled = 0;
        try {
            for (int round = 0; round < 300; round++) {
                Path f = envWith(keys);
                java.util.concurrent.CountDownLatch go = new java.util.concurrent.CountDownLatch(1);
                int r = round;
                var a = pool.submit(() -> {
                    go.await();
                    DotEnvSettings.save(f, "SPECTRO_HUB_ENABLED", r % 2 == 0 ? "true" : "false");
                    DotEnvSettings.keepCommentedDefaults(f);
                    return null;
                });
                var b = pool.submit(() -> {
                    go.await();
                    DotEnvSettings.save(f, "SPECTRO_HUB_PORT", "");
                    DotEnvSettings.keepCommentedDefaults(f);
                    return null;
                });
                go.countDown();
                a.get();
                b.get();
                String text = Files.readString(f);
                if (!text.contains("ANTHROPIC_API_KEY=sk-ant-FAKE-test-value-0001")
                        || !text.contains("OPENAI_API_KEY=\"quoted=with=equals\"")
                        || !text.contains("SPECTRO_HUB_ENABLED=")) {
                    lost++;
                }
                if (text.lines().filter(l -> l.startsWith("# SPECTRO_HUB_ENABLED=")).count() > 1
                        || text.lines().filter(l -> l.startsWith("# SPECTRO_HUB_PORT=")).count() > 1) {
                    doubled++;
                }
            }
        } finally {
            pool.shutdownNow();
        }
        assertEquals(0, lost, "rounds that lost a key or a setting");
        assertEquals(0, doubled, "rounds with a doubled comment line");
    }

    @Test
    void twoCommentStepsAtOnceAddEachCommentOnce() throws Exception {
        // Two comment steps at once on a file without the comments. The step
        // holds the same lock as the writer, so each comment lands once.
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(2);
        int doubled = 0;
        int lost = 0;
        try {
            for (int round = 0; round < 300; round++) {
                Path f = envWith("ANTHROPIC_API_KEY=sk-ant-FAKE-test-value-0001\n");
                java.util.concurrent.CountDownLatch go = new java.util.concurrent.CountDownLatch(1);
                var a = pool.submit(() -> {
                    go.await();
                    DotEnvSettings.keepCommentedDefaults(f);
                    return null;
                });
                var b = pool.submit(() -> {
                    go.await();
                    DotEnvSettings.keepCommentedDefaults(f);
                    return null;
                });
                go.countDown();
                a.get();
                b.get();
                List<String> lines = Files.readAllLines(f);
                if (lines.stream().filter(l -> l.startsWith("# SPECTRO_HUB_ENABLED=")).count() != 1
                        || lines.stream().filter(l -> l.startsWith("# SPECTRO_HUB_PORT=")).count() != 1) {
                    doubled++;
                }
                if (!lines.contains("ANTHROPIC_API_KEY=sk-ant-FAKE-test-value-0001")) {
                    lost++;
                }
            }
        } finally {
            pool.shutdownNow();
        }
        assertEquals(0, doubled, "rounds without exactly one of each comment");
        assertEquals(0, lost, "rounds that lost a line");
    }

    @Test
    void aSaveKeepsTheFileOwnerOnlyAndLeavesNoTempFileBehind() throws Exception {
        Path f = envWith("ANTHROPIC_API_KEY=sk-ant-FAKE\n");
        DotEnvSettings.save(f, "SPECTRO_HUB_ENABLED", "true");
        assertEquals("rw-------", java.nio.file.attribute.PosixFilePermissions.toString(
                Files.getPosixFilePermissions(f)));
        try (var listing = Files.list(home)) {
            assertEquals(List.of(".env"), listing.map(p -> p.getFileName().toString()).toList());
        }
        assertEquals(List.of("ANTHROPIC_API_KEY=sk-ant-FAKE", "SPECTRO_HUB_ENABLED=true", "# SPECTRO_HUB_PORT=7700"),
                Files.readAllLines(f));
    }
}
