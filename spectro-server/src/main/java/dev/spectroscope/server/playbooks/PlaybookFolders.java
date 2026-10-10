package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The playbook folders the owner knows and the one pinned to each workspace,
 * kept in {@code ~/.spectro/playbooks.json}:
 * {@code {"folders":[...],"active":{"<workspace>":"<folder>"}}}.
 *
 * <p>Every stored path is a real path. Only registered folders can be loaded
 * or pinned, so the wire cannot make the loader read an arbitrary directory.
 * Writes go to a temp file first and are moved into place atomically.
 */
public final class PlaybookFolders {

    /** The file's content: known folders and the active folder per workspace. */
    public record State(List<String> folders, Map<String, String> activeByWorkspace) {}

    private static final ObjectMapper JSON = new ObjectMapper();
    static final String PLAYBOOK_FILE = "playbook.json";

    private final Path file;

    public PlaybookFolders(Path file) {
        this.file = file;
    }

    /** The store in the operator's home, {@code ~/.spectro/playbooks.json}. */
    public static PlaybookFolders inHome() {
        return new PlaybookFolders(Path.of(System.getProperty("user.home"), ".spectro", "playbooks.json"));
    }

    public synchronized State read() {
        List<String> folders = new ArrayList<>();
        Map<String, String> active = new LinkedHashMap<>();
        if (Files.isRegularFile(file)) {
            try {
                JsonNode root = JSON.readTree(Files.readString(file, StandardCharsets.UTF_8));
                if (root != null && root.path("folders").isArray()) {
                    for (JsonNode f : root.get("folders")) {
                        if (f.isTextual()) folders.add(f.asText());
                    }
                }
                if (root != null && root.path("active").isObject()) {
                    root.get("active").fields().forEachRemaining(e -> {
                        if (e.getValue().isTextual()) active.put(e.getKey(), e.getValue().asText());
                    });
                }
            } catch (IOException unreadable) {
                // A damaged file reads as empty; the next write replaces it.
                folders.clear();
                active.clear();
            }
        }
        return new State(List.copyOf(folders), Map.copyOf(active));
    }

    /** Remembers a folder that holds a {@code playbook.json}. Idempotent. */
    public synchronized void register(Path folder) {
        Path real = realFolderWithPlaybook(folder);
        State state = read();
        String stored = real.toString();
        if (state.folders().contains(stored)) return;
        List<String> next = new ArrayList<>(state.folders());
        next.add(stored);
        write(next, state.activeByWorkspace());
    }

    /** Pins a registered folder to a workspace. */
    public synchronized void pin(Path workspace, Path folder) {
        Path real = realFolderWithPlaybook(folder);
        State state = read();
        if (!state.folders().contains(real.toString())) {
            throw new IllegalArgumentException("folder is not registered: " + real);
        }
        Map<String, String> next = new LinkedHashMap<>(state.activeByWorkspace());
        next.put(key(workspace), real.toString());
        write(state.folders(), next);
    }

    /** The folder pinned to the workspace, or {@code null} when none (or it no longer holds a playbook). */
    public synchronized Path activeFor(Path workspace) {
        String stored = read().activeByWorkspace().get(key(workspace));
        if (stored == null) return null;
        Path folder = Path.of(stored);
        return Files.isRegularFile(folder.resolve(PLAYBOOK_FILE)) ? folder : null;
    }

    private static Path realFolderWithPlaybook(Path folder) {
        Path real;
        try {
            real = folder.toRealPath();
        } catch (IOException e) {
            throw new IllegalArgumentException("not a folder: " + folder);
        }
        if (!Files.isDirectory(real)) throw new IllegalArgumentException("not a folder: " + folder);
        if (!Files.isRegularFile(real.resolve(PLAYBOOK_FILE))) {
            throw new IllegalArgumentException("no " + PLAYBOOK_FILE + " in " + folder);
        }
        return real;
    }

    private static String key(Path workspace) {
        try {
            return workspace.toRealPath().toString();
        } catch (IOException missing) {
            return workspace.toAbsolutePath().normalize().toString();
        }
    }

    private void write(List<String> folders, Map<String, String> active) {
        ObjectNode root = JSON.createObjectNode();
        ArrayNode list = root.putArray("folders");
        folders.forEach(list::add);
        ObjectNode map = root.putObject("active");
        active.forEach(map::put);
        Path scratch = file.resolveSibling(file.getFileName() + ".tmp");
        try {
            Files.createDirectories(file.toAbsolutePath().getParent());
            Files.writeString(scratch, JSON.writerWithDefaultPrettyPrinter().writeValueAsString(root),
                    StandardCharsets.UTF_8);
            Files.move(scratch, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
