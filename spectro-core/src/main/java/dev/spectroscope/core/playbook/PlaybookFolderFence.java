package dev.spectroscope.core.playbook;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Card 554, criterion 8d from the owner's model: a session reads its
 * playbook and never writes it. The agent's file tools that create or change
 * a file ask this fence before they touch a path, in every permission mode,
 * the extended one included, and also when a playbook folder lies inside the
 * workspace. A playbook is changed in the Playbook view, which writes through
 * the server and never through an agent's tool. One exception (owner,
 * 2026-10-13, card 558): a playbook folder that is the session's working
 * folder, by real path, is written like any working folder. A playbook folder
 * inside the working folder, and every other registered folder, stays fenced.
 *
 * <p>The registry of playbook folders is the file the server keeps
 * ({@code ~/.spectro/playbooks.json}, {@code {"folders":[...],"active":{...}}});
 * its location is named here once, and the server's {@code PlaybookFolders}
 * takes it from here. The file is read per question, because a folder the
 * owner registers while a session runs is a playbook from that moment on.</p>
 */
public final class PlaybookFolderFence {

    /** The registry's file name in {@code ~/.spectro}. */
    public static final String FILE = "playbooks.json";

    private static final ObjectMapper JSON = new ObjectMapper();

    private PlaybookFolderFence() {
    }

    /** @return the registry file in the operator's home, {@code ~/.spectro/playbooks.json} */
    public static Path registryFile() {
        return Path.of(System.getProperty("user.home"), SpectroDir.NAME, FILE);
    }

    /**
     * The registered playbook folders, each as a real path when it still
     * resolves. A registry that is missing or does not read names none: the
     * fence is a floor under the tools, and an unreadable file must not stop
     * every write in the workspace.
     *
     * @return the folders, in the registry's order
     */
    public static List<Path> registeredFolders() {
        Path registry = registryFile();
        List<Path> out = new ArrayList<>();
        if (!Files.isRegularFile(registry)) {
            return out;
        }
        try {
            JsonNode root = JSON.readTree(Files.readString(registry, StandardCharsets.UTF_8));
            if (root == null || !root.path("folders").isArray()) {
                return out;
            }
            for (JsonNode entry : root.get("folders")) {
                if (!entry.isTextual() || entry.asText().isBlank()) {
                    continue;
                }
                Path folder = Path.of(entry.asText()).toAbsolutePath().normalize();
                try {
                    folder = folder.toRealPath();
                } catch (IOException gone) {
                    // A folder that does not resolve is fenced by its stored path.
                }
                out.add(folder);
            }
        } catch (IOException | RuntimeException unreadable) {
            return List.of();
        }
        return out;
    }

    /**
     * @param file          a path a tool is about to create or change, canonical as the
     *                      tool's sandbox rule resolved it
     * @param workingFolder the session's working folder; a registered folder with the same
     *                      real path does not count
     * @return the registered playbook folder the path lies in, or null when none
     */
    public static Path folderHolding(Path file, Path workingFolder) {
        Path target = file.toAbsolutePath().normalize();
        Path working = realOrNormal(workingFolder);
        for (Path folder : registeredFolders()) {
            if (folder.equals(working)) {
                continue;
            }
            if (target.equals(folder) || target.startsWith(folder)) {
                return folder;
            }
        }
        return null;
    }

    private static Path realOrNormal(Path folder) {
        if (folder == null) {
            return null;
        }
        Path normal = folder.toAbsolutePath().normalize();
        try {
            return normal.toRealPath();
        } catch (IOException gone) {
            return normal;
        }
    }

    /**
     * @param tool          the tool's wire name, for the sentence
     * @param file          the path the tool resolved
     * @param workingFolder the session's working folder, the tool context's cwd
     * @return the refusal the model reads, or null when the path lies in no playbook folder
     */
    public static String refusal(String tool, Path file, Path workingFolder) {
        Path folder = folderHolding(file, workingFolder);
        if (folder == null) {
            return null;
        }
        return "ERROR: " + tool + " will not change " + file + ": it lies in the playbook folder " + folder
                + ". A session only reads its playbook; the playbook is changed in the Playbook view.";
    }
}
