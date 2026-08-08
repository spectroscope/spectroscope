package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The published wire contract against the wire. Commit 87d771c changed the
 * transcript listing from a bare array to an object and raised the content cap
 * from 64 MB to 128 MiB, and touched no documentation at all: a client written
 * to the guide saw zero rows where the server served rows, and refused a 70 MiB
 * file the server hands over.
 *
 * <p>Nothing caught it, because {@code build_api_collections.py} scans
 * {@code @*Mapping} annotations, which means it verifies paths and methods and
 * never reads a description. Same shape as {@code HeapFlagDriftTest}: when a
 * fact is restated in files that cannot import each other, the test has to go
 * and look.
 */
class WireDocDriftTest {

    private static final Path CONTROLLER = Path.of(
            "spectro-server/src/main/java/dev/spectroscope/server/transcripts/ClaudeTranscriptsController.java");
    private static final Path WIRE_PART = Path.of("docs/guide-assets/parts/16-ref-wire.html");
    private static final Path ENDPOINTS = Path.of("docs/api-collections/endpoints.json");

    /** The endpoints this branch fenced, and the controller each one lives in. */
    private static final Map<String, String> FENCED = Map.of(
            "/api/files", "WorkspaceController.java",
            "/api/file", "WorkspaceController.java",
            "/api/claude/transcripts", "transcripts/ClaudeTranscriptsController.java",
            "/api/claude/transcripts/content", "transcripts/ClaudeTranscriptsController.java");

    @Test
    void theWireReferencePublishesTheCapTheServerEnforces() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        long cap = capFromSource(root);
        String row = rowFor(root, "GET /api/claude/transcripts/content?path=");

        assertTrue(row.contains(human(cap)),
                "the wire reference names a different transcript cap than the server enforces ("
                        + human(cap) + "): " + row);
        assertFalse(row.contains("64 MB"),
                "the wire reference still advertises the cap the server raised: " + row);
    }

    @Test
    void theWireReferenceDoesNotAdvertiseTheListingAsABareArray() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        String row = rowFor(root, "GET /api/claude/transcripts");

        // The shape cell, not the row: the rows themselves are still an array,
        // nested inside the envelope. What must not come back is a cell that
        // OPENS with one, which is what a client codes against.
        assertFalse(row.contains("<td><code>[{"),
                "the listing answers an object; a client written to this array shape reads no rows: " + row);
        assertTrue(row.contains("limitBytes") && row.contains("transcripts"),
                "the listing's envelope fields are not published: " + row);
    }

    @Test
    void theApiCollectionsDoNotCallAFencedEndpointUnfenced() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        JsonNode table = new ObjectMapper().readTree(Files.readString(root.resolve(ENDPOINTS)));

        for (Map.Entry<String, String> entry : FENCED.entrySet()) {
            String source = Files.readString(root.resolve(
                    "spectro-server/src/main/java/dev/spectroscope/server/" + entry.getValue()));
            assertTrue(source.contains("isLocalOrigin"),
                    entry.getValue() + " lost its local-origin fence (card 74)");

            JsonNode row = rowFor(table, entry.getKey());
            assertFalse("none".equals(row.path("fence").asText()),
                    entry.getKey() + " is fenced in the source and published as unfenced,"
                            + " so every generated collection tells a client the wrong thing");
        }
    }

    @Test
    void theOnlyEndpointPublishedAsUnfencedIsTheOneTheFilterLeavesOpen() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        JsonNode table = new ObjectMapper().readTree(Files.readString(root.resolve(ENDPOINTS)));

        // The fence moved into ApiLocalFence, which is default-deny: a row can
        // no longer be honestly "none" unless the filter names that exact path.
        // Without this, a table row keeps telling client authors an endpoint is
        // open long after the code closed it, which is the drift card 74 found
        // (five rows said "none" against a server that had fenced four of them).
        for (JsonNode endpoint : table.path("endpoints")) {
            String path = endpoint.path("path").asText();
            if ("none".equals(endpoint.path("fence").asText())) {
                assertTrue(ApiLocalFence.isOpen(path),
                        path + " is published as unfenced, but the API filter fences it —"
                                + " every generated collection tells a client the wrong thing");
            }
        }
    }

    @Test
    void theCollectionDescriptionOfTheTranscriptCapMatchesTheSource() throws IOException {
        Path root = repoRoot();
        assumeTrue(root != null, "not running from a source checkout");
        long cap = capFromSource(root);
        JsonNode table = new ObjectMapper().readTree(Files.readString(root.resolve(ENDPOINTS)));
        String description = rowFor(table, "/api/claude/transcripts/content")
                .path("description").asText();

        assertTrue(description.contains(human(cap)),
                "the collection names a different cap than the server enforces: " + description);
    }

    private static JsonNode rowFor(JsonNode table, String path) {
        for (JsonNode endpoint : table.path("endpoints")) {
            if (path.equals(endpoint.path("path").asText())) {
                return endpoint;
            }
        }
        throw new AssertionError("no endpoint row for " + path);
    }

    /** The one table row whose first cell names this endpoint. */
    private static String rowFor(Path root, String endpoint) throws IOException {
        for (String line : Files.readAllLines(root.resolve(WIRE_PART))) {
            if (line.contains("<code>" + endpoint + "</code>")) {
                return line;
            }
        }
        throw new AssertionError("the wire reference no longer documents " + endpoint);
    }

    private static long capFromSource(Path root) throws IOException {
        Matcher matcher = Pattern.compile("MAX_CONTENT_BYTES\\s*=\\s*([^;]+);")
                .matcher(Files.readString(root.resolve(CONTROLLER)));
        assertTrue(matcher.find(), "MAX_CONTENT_BYTES is gone from ClaudeTranscriptsController");
        long product = 1L;
        for (String factor : matcher.group(1).replace("_", "").replace("L", "").split("\\*")) {
            product *= Long.parseLong(factor.trim());
        }
        return product;
    }

    /** The cap the way the docs write it, in the binary units the javadoc uses. */
    private static String human(long bytes) {
        return (bytes / (1024 * 1024)) + " MiB";
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
