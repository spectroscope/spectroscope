package dev.spectroscope.server.settings;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * The boot-time half of card 199's one-time migration. Before this runner the
 * settings page could show a launch-dir {@code write_file} entry as a READ entry
 * between boot and the first run — an honest reading of an unmigrated line, and
 * a misleading picture of what the file approves.
 */
class AllowlistMigrationRunnerTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void theLaunchDirProjectFileIsMigratedAtBootAndOnlyOnce(@TempDir Path launchDir)
            throws Exception {
        Path settings = launchDir.resolve(".spectro").resolve("settings.json");
        Files.createDirectories(settings.getParent());
        Files.writeString(settings, """
                {"autoApprove":["write_file","run_command:git status*"]}""");

        AllowlistMigrationRunner runner = new AllowlistMigrationRunner(launchDir);
        assertEquals(1, runner.migrate(), "one file carried entries to migrate");
        assertEquals(List.of("write_file#write", "run_command#eval-execute:git status*"),
                entries(settings));

        assertEquals(0, runner.migrate(), "a second boot rewrites nothing");
        assertEquals(List.of("write_file#write", "run_command#eval-execute:git status*"),
                entries(settings));
    }

    private static List<String> entries(Path settings) throws Exception {
        JsonNode array = JSON.readTree(Files.readString(settings)).path("autoApprove");
        List<String> out = new ArrayList<>();
        array.forEach(node -> out.add(node.asText()));
        return out;
    }
}
