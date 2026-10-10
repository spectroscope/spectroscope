package dev.spectroscope.server.providers;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The two provider registry routes are published where a reader looks: in the
 * endpoint table the API collections are generated from, and in the provider
 * chapter of both guide editions.
 *
 * <p>The routes are read from the controller annotations, so a renamed route
 * fails here instead of leaving a table row that describes a path nobody
 * serves.</p>
 */
class ProvidersDocDriftTest {

    private static final Path ENDPOINTS = Path.of("docs/api-collections/endpoints.json");
    private static final List<String> EDITIONS =
            List.of("docs/USER-GUIDE.html", "docs/USER-GUIDE-LIGHT.html");

    private static String readRoute() throws NoSuchMethodException {
        return ProvidersController.class.getMethod("list").getAnnotation(GetMapping.class).value()[0];
    }

    private static String checkRoute() throws NoSuchMethodException {
        return ProvidersController.class
                .getMethod("check", String.class, jakarta.servlet.http.HttpServletRequest.class)
                .getAnnotation(PostMapping.class).value()[0];
    }

    private static JsonNode row(JsonNode table, String method, String path) {
        for (JsonNode endpoint : table.path("endpoints")) {
            if (method.equals(endpoint.path("method").asText())
                    && path.equals(endpoint.path("path").asText())) {
                return endpoint;
            }
        }
        throw new AssertionError(method + " " + path + " has no row in " + ENDPOINTS
                + ", so every generated API collection leaves it out");
    }

    @Test
    void theEndpointTableCarriesBothRegistryRoutesWithTheirFences() throws Exception {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        JsonNode table = new ObjectMapper().readTree(Files.readString(root.resolve(ENDPOINTS)));

        JsonNode read = row(table, "GET", readRoute());
        assertEquals("host", read.path("fence").asText());
        assertEquals(false, read.path("writes").asBoolean(true));

        JsonNode check = row(table, "POST", checkRoute());
        assertEquals("host+origin", check.path("fence").asText(),
                "the check route answers 404 to a foreign Origin, so the table must say host+origin");
        assertEquals("provider", check.path("query").path(0).path("name").asText());
        assertEquals(table.path("endpoints").size(), table.path("meta").path("endpointCount").asInt(),
                "meta.endpointCount must follow the rows");
    }

    @Test
    void bothGuideEditionsDescribeTheProviderOverview() throws Exception {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        for (String edition : EDITIONS) {
            String guide = Files.readString(root.resolve(edition));
            assertTrue(guide.contains("id=\"ch-providers-overview\""),
                    edition + " has no provider overview section; rebuild it from the parts");
            assertTrue(guide.contains(readRoute()) && guide.contains(checkRoute()),
                    edition + " never names the two registry routes " + readRoute() + " and " + checkRoute());
        }
    }

    private static Path repoRoot() {
        for (Path candidate = Path.of("").toAbsolutePath();
                candidate != null; candidate = candidate.getParent()) {
            if (Files.isRegularFile(candidate.resolve("settings.gradle.kts"))) {
                return candidate;
            }
        }
        return null;
    }
}
