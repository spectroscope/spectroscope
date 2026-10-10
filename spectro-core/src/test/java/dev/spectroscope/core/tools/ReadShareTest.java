package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.CancelSignal;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 493, criterion 3: {@code read_file} judges a whole read against the
 * run's read share, not against a constant. At the shipped 25 it reads and
 * describes itself exactly as v0.14.4 did.
 *
 * <p>The numbers: a window of 10,000 tokens admits 2,500 tokens at 25 % and
 * 1,000 at 10 %, which is 7,500 and 3,000 bytes at the estimate of 3 bytes
 * per token. A file of 5,000 bytes sits between the two.</p>
 */
class ReadShareTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int WINDOW = 10_000;

    /** The v0.14.4 description, copied from {@code StandardTools} at {@code 8d7fcf48}. */
    private static final String V0144_DESCRIPTION = "Reads a text file relative to the working"
            + " directory, whole when it fits 25 % of your context window. Larger files: page"
            + " with offset (1-based line) and limit (line count).";

    private static Tool readFile() {
        Map<String, Tool> byName = StandardTools.all(10).stream()
                .collect(Collectors.toMap(Tool::name, Function.identity()));
        return byName.get("read_file");
    }

    private static Tool.ToolContext context(Path cwd, int share) {
        return new Tool.ToolContext(cwd, new CancelSignal(), "main", "c1", event -> { },
                attachment -> { }, change -> { }, millis -> { }, false, WINDOW, share);
    }

    private static JsonNode path(String path) {
        return JSON.createObjectNode().put("path", path);
    }

    private static void fileOf(Path cwd, String name, int bytes) throws IOException {
        StringBuilder text = new StringBuilder();
        while (text.length() < bytes) {
            text.append("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123\n");
        }
        Files.writeString(cwd.resolve(name), text.substring(0, bytes));
    }

    @Test
    void atTenPercentAWholeReadThatFitsTwentyFiveIsRefusedWithThePagingHint(@TempDir Path cwd)
            throws IOException {
        fileOf(cwd, "mid.txt", 5_000);
        String atDefault = readFile().execute(path("mid.txt"), context(cwd, 25));
        assertFalse(atDefault.startsWith("ERROR"), "premise: 25 % admits the file: " + atDefault);
        String atTen = readFile().execute(path("mid.txt"), context(cwd, 10));
        assertTrue(atTen.startsWith("ERROR: file too large to read at once"), atTen);
        assertTrue(atTen.contains("one read may take 10 % of the 10000 tokens context window, 1000 tokens"),
                atTen);
        assertTrue(atTen.endsWith("Page with offset (1-based line) and limit (line count)."), atTen);
    }

    @Test
    void aShareOfZeroIsTheShippedShare(@TempDir Path cwd) throws IOException {
        fileOf(cwd, "mid.txt", 5_000);
        assertFalse(readFile().execute(path("mid.txt"), context(cwd, 0)).startsWith("ERROR"),
                "a context that names no share read with another one than 25 %");
    }

    @Test
    void aPageIsBoundByTheShareToo(@TempDir Path cwd) throws IOException {
        fileOf(cwd, "mid.txt", 5_000);
        JsonNode page = JSON.createObjectNode().put("path", "mid.txt").put("offset", 1).put("limit", 1000);
        String atTen = readFile().execute(page, context(cwd, 10));
        assertTrue(atTen.startsWith("ERROR: page too large (more than 3000 bytes"), atTen);
        assertTrue(atTen.contains("10 % of the 10000 tokens"), atTen);
        JsonNode small = JSON.createObjectNode().put("path", "mid.txt").put("offset", 1).put("limit", 10);
        assertFalse(readFile().execute(small, context(cwd, 10)).startsWith("ERROR"),
                "a page under the bound was refused");
    }

    @Test
    void theShippedDescriptionIsTheV0144One() {
        assertEquals(V0144_DESCRIPTION, readFile().description());
        assertEquals(V0144_DESCRIPTION, readFile().descriptionForRun(new Tool.RunFacts(25)));
        assertEquals(V0144_DESCRIPTION, readFile().descriptionForRun(new Tool.RunFacts(0)),
                "facts that name no share describe the tool with another one than 25 %");
    }

    @Test
    void theDescriptionForARunNamesTheRunsShare() {
        String described = readFile().descriptionForRun(new Tool.RunFacts(10));
        assertEquals(V0144_DESCRIPTION.replace("fits 25 %", "fits 10 %"), described);
    }

    @Test
    void theRegistryDescribesEveryToolForTheRun() {
        ToolRegistry registry = new ToolRegistry();
        StandardTools.all(10).forEach(registry::register);
        String readSpec = registry.specs(new Tool.RunFacts(10)).stream()
                .filter(spec -> spec.name().equals("read_file")).findFirst().orElseThrow().description();
        assertTrue(readSpec.contains("fits 10 %"), readSpec);
        assertEquals(registry.specs(), registry.specs(new Tool.RunFacts(25)),
                "at the shipped share the run's specs differ from the plain ones");
    }
}
