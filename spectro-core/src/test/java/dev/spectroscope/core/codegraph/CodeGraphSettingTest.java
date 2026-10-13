package dev.spectroscope.core.codegraph;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Card 587, fix round (I4): one resolver says which backend a folder uses, from
 * the user's settings, the start folder's and the folder's own settings. The
 * session's tool, the skill offer, the build endpoints and the System context
 * view all ask it.
 *
 * <p>graphify is the only legal value today, so these tests cannot tell a read
 * scope from a skipped one by the answer. What they hold is that a refused
 * value in a folder or in the start folder costs that scope and never the
 * reader: every reader gets an answer, and it is the one the scopes below give.
 * Which folder each reader asks for is pinned in the readers' own tests with a
 * second backend.</p>
 */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class CodeGraphSettingTest {

    private static Path settings(Path folder, String json) throws IOException {
        Path file = folder.resolve(SpectroConfig.PROJECT_SETTINGS);
        Files.createDirectories(file.getParent());
        Files.writeString(file, json);
        return folder;
    }

    @Test
    void aFolderWithoutItsOwnSettingsReadsTheScopesBelow(@TempDir Path start, @TempDir Path folder) {
        assertEquals(CodeGraphBackend.GRAPHIFY, CodeGraphSetting.backendFor(start, folder));
        assertEquals(CodeGraphBackend.GRAPHIFY, CodeGraphSetting.backendFor(start, null));
    }

    @Test
    void aFolderMayNameTheBackendInItsOwnSettings(@TempDir Path start, @TempDir Path folder) throws IOException {
        settings(folder, "{\"codeGraphBackend\":\"graphify\"}");
        assertEquals("graphify", SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(), start, folder)
                .codeGraphBackend(), "premise: the folder's file is read and accepted");
        assertEquals(CodeGraphBackend.GRAPHIFY, CodeGraphSetting.backendFor(start, folder));
    }

    @Test
    void aRefusedValueInTheFolderCostsTheFolderAndNotTheReader(@TempDir Path start, @TempDir Path folder)
            throws IOException {
        settings(folder, "{\"codeGraphBackend\":\"othergraph\"}");
        assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.loadForWorkspace(SpectroConfig.Overrides.none(), start, folder),
                "premise: the folder's file is refused as a whole");
        assertEquals(CodeGraphSetting.backendFor(start, null), CodeGraphSetting.backendFor(start, folder));
    }

    @Test
    void aRefusedValueInTheStartFolderLeavesTheShippedBackend(@TempDir Path start, @TempDir Path folder)
            throws IOException {
        settings(start, "{\"codeGraphBackend\":\"othergraph\"}");
        assertThrows(IllegalArgumentException.class,
                () -> SpectroConfig.load(SpectroConfig.Overrides.none(), start),
                "premise: the start folder's file is refused as a whole");
        assertEquals(CodeGraphBackend.GRAPHIFY, CodeGraphSetting.backendFor(start, folder));
        assertEquals(CodeGraphBackend.GRAPHIFY, CodeGraphSetting.backendFor(start, null));
    }
}
