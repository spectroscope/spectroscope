package dev.spectroscope.server.web;

import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpHeaders;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * The SearXNG setup script the app serves (card 531).
 *
 * <p>The Settings block offers a download of this file from the running app,
 * so a DMG user needs no git and no clone. The jar carries a copy of
 * {@code samples/09-searxng/install.sh}, made by the build; the tests below
 * hold that copy to the sample, the answer to its headers, and the route to
 * the one the web bundle prints.</p>
 */
class LocalSetupScriptControllerTest {

    static final Path ROOT = repoRoot();
    static final Path SAMPLE = ROOT.resolve("samples/09-searxng/install.sh");
    static final Path WEB_SETUP = ROOT.resolve("spectro-web/src/components/webSearchSetup.ts");

    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(new LocalSetupScriptController()).build();

    @Test
    void theScriptAnswersAsPlainTextToSaveNotToRender() throws Exception {
        MvcResult result = mvc.perform(get("/local-setup/scripts/install-searxng.sh")).andReturn();
        var response = result.getResponse();
        assertEquals(200, response.getStatus());
        assertEquals("text/plain;charset=UTF-8", response.getContentType().replace(" ", ""));
        String disposition = response.getHeader(HttpHeaders.CONTENT_DISPOSITION);
        assertNotNull(disposition, "no Content-Disposition: a browser would show the script instead of saving it");
        assertTrue(disposition.startsWith("attachment"), disposition);
        assertTrue(disposition.contains("filename=\"install-searxng.sh\""), disposition);
        assertEquals("nosniff", response.getHeader("X-Content-Type-Options"));
        assertArrayEquals(Files.readAllBytes(SAMPLE), response.getContentAsByteArray(),
                "the served script differs from samples/09-searxng/install.sh");
    }

    @Test
    void theJarCarriesTheSampleByteForByte() throws IOException {
        // processResources copies the sample; a hand edit of either side, or a
        // build that skipped the copy, turns this red.
        ClassPathResource copy = new ClassPathResource(LocalSetupScriptController.RESOURCE);
        assertTrue(copy.exists(), "the build did not put " + LocalSetupScriptController.RESOURCE + " on the classpath");
        try (InputStream in = copy.getInputStream()) {
            assertArrayEquals(Files.readAllBytes(SAMPLE), in.readAllBytes(),
                    LocalSetupScriptController.RESOURCE + " differs from samples/09-searxng/install.sh");
        }
    }

    @Test
    void theWebBundlePrintsTheRouteThisControllerServes() throws IOException {
        String source = Files.readString(WEB_SETUP, StandardCharsets.UTF_8);
        Matcher route = Pattern.compile("SEARXNG_SCRIPT_ROUTE\\s*=\\s*\"([^\"]+)\"").matcher(source);
        assertTrue(route.find(), "webSearchSetup.ts no longer names SEARXNG_SCRIPT_ROUTE");
        assertEquals(LocalSetupScriptController.ROUTE, route.group(1));
    }

    @Test
    void anyOtherNameUnderTheFolderIsNotThisController() throws Exception {
        // One fixed file, no path variable: nothing here reads a name from the request.
        assertEquals(404, mvc.perform(get("/local-setup/scripts/..%2Fapplication.properties")).andReturn()
                .getResponse().getStatus());
        assertEquals(404, mvc.perform(get("/local-setup/scripts/other.sh")).andReturn()
                .getResponse().getStatus());
    }

    private static Path repoRoot() {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null && !Files.exists(dir.resolve("settings.gradle.kts"))) {
            dir = dir.getParent();
        }
        assertNotNull(dir, "repo root (the directory holding settings.gradle.kts) not found");
        return dir;
    }
}
