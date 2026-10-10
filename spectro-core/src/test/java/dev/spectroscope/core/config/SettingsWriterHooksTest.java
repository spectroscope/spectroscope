package dev.spectroscope.core.config;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SettingsWriterHooksTest {

    @TempDir Path tmp;

    static final String EXISTING = """
        { "promptCaching": true,
          "hooks": [ { "event": "post_tool_use", "command": "echo mine" } ] }
        """;

    @Test
    void appendsKeepsEverythingElseAndDoesNotDuplicate() throws IOException {
        Path file = tmp.resolve("settings.json");
        Files.writeString(file, EXISTING);
        HookConfig guard = new HookConfig("run_command", "pre_tool_use", "sh /h/guard.sh", null);
        assertEquals(List.of(guard), SettingsWriter.appendHooks(file, List.of(guard)));
        assertEquals(List.of(), SettingsWriter.appendHooks(file, List.of(guard)), "an equal entry is not added twice");
        String text = Files.readString(file);
        assertTrue(text.contains("\"promptCaching\" : true"), text);
        assertTrue(text.contains("echo mine"), text);
        // EXISTING has no matcher and a post_tool_use event, so both indexes land in the appended entry.
        assertTrue(text.indexOf("pre_tool_use") < text.indexOf("\"matcher\""), "event is written before matcher");
        assertTrue(text.indexOf("\"matcher\"") < text.indexOf("sh /h/guard.sh"), "matcher is written before command");
        assertTrue(!text.contains("timeoutSeconds"), "a null timeout is left out");
    }

    @Test
    void removesOnlyTheEqualEntry() throws IOException {
        Path file = tmp.resolve("settings.json");
        Files.writeString(file, EXISTING);
        HookConfig guard = new HookConfig("run_command", "pre_tool_use", "sh /h/guard.sh", null);
        SettingsWriter.appendHooks(file, List.of(guard));
        HookConfig edited = new HookConfig("run_command", "pre_tool_use", "sh /h/guard.sh --strict", null);
        assertEquals(List.of(), SettingsWriter.removeHooks(file, List.of(edited)));
        assertEquals(List.of(guard), SettingsWriter.removeHooks(file, List.of(guard)));
        assertTrue(Files.readString(file).contains("echo mine"));
    }

    @Test
    void anEntryThatDiffersInOneRawFieldIsAnotherEntry() throws IOException {
        Path file = tmp.resolve("settings.json");
        Files.writeString(file, EXISTING);
        HookConfig guard = new HookConfig("run_command", "pre_tool_use", "sh /h/guard.sh", null);
        SettingsWriter.appendHooks(file, List.of(guard));
        // Same command as guard, one other field each: none of them is guard.
        HookConfig otherEvent = new HookConfig("run_command", "post_tool_use", "sh /h/guard.sh", null);
        HookConfig otherMatcher = new HookConfig("write_file", "pre_tool_use", "sh /h/guard.sh", null);
        HookConfig otherTimeout = new HookConfig("run_command", "pre_tool_use", "sh /h/guard.sh", 30);
        assertEquals(List.of(), SettingsWriter.removeHooks(file, List.of(otherEvent)), "event is compared");
        assertEquals(List.of(), SettingsWriter.removeHooks(file, List.of(otherMatcher)), "matcher is compared");
        assertEquals(List.of(), SettingsWriter.removeHooks(file, List.of(otherTimeout)), "timeout is compared");
        assertEquals(List.of(otherTimeout), SettingsWriter.appendHooks(file, List.of(otherTimeout)),
                "an entry that differs only in its timeout is appended");
        assertTrue(Files.readString(file).contains("\"timeoutSeconds\" : 30"));
        assertEquals(List.of(guard), SettingsWriter.removeHooks(file, List.of(guard)));
        assertEquals(List.of(otherTimeout), SettingsWriter.removeHooks(file, List.of(otherTimeout)));
    }

    @Test
    void aFileThatWouldNotBindIsLeftAlone() throws IOException {
        Path file = tmp.resolve("settings.json");
        String broken = "{ \"maxRetries\": \"many\" }";
        Files.writeString(file, broken);
        HookConfig guard = new HookConfig(null, "pre_tool_use", "true", null);
        assertThrows(IllegalArgumentException.class, () -> SettingsWriter.appendHooks(file, List.of(guard)));
        assertEquals(broken, Files.readString(file));
    }
}
