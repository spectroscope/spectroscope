package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookValidator;
import dev.spectroscope.core.playbook.PlaybookWriter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What the playbook editor needs to know about a text: the load answer
 * ({@link PlaybookLoader.Loaded}), the canonical file tree of the parsed
 * playbook, the hash of the bytes on disk, whether the text is already in the
 * canonical form, whether a save would lose nothing, the outcomes every node
 * can leave by, and the state of every model choice's provider.
 *
 * @param loaded    the playbook, its drawing, its findings and the step resolutions
 * @param document  the canonical file tree of the parsed playbook, or null when it did not parse
 * @param diskHash  the sha256 (lowercase hex) of {@code playbook.json} as it is on disk
 * @param canonical whether the canonical form of the playbook equals the text on disk
 * @param editable  whether the text was read with no reader finding, so a save drops nothing
 * @param outcomes  per node that is not an end, the outcomes it can leave by in order
 * @param choices   every model choice with the state of its primary provider
 */
public record EditorView(PlaybookLoader.Loaded loaded, JsonNode document, String diskHash, boolean canonical,
        boolean editable, Map<String, List<String>> outcomes, List<ChoiceState> choices) {

    /** One model choice with the state of the provider its primary names. */
    public record ChoiceState(String choice, String provider, String model, String state, String reason) {}

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * The view of {@code json} for the folder {@code dir}, whose file on disk has the bytes {@code disk}.
     */
    static EditorView of(Path dir, String json, byte[] disk, Path workspace, SpectroConfig config) {
        return of(dir, json, disk, workspace, config, ProviderStates.current());
    }

    static EditorView of(Path dir, String json, byte[] disk, Path workspace, SpectroConfig config,
            ProviderStates providers) {
        PlaybookLoader.Loaded loaded = PlaybookLoader.fromJson(dir, json, workspace, config, providers);
        Playbook playbook = loaded.playbook();
        boolean editable = PlaybookReader.read(json).findings().isEmpty();
        String canonicalText = playbook == null ? null : PlaybookWriter.write(playbook);
        boolean canonical = canonicalText != null && canonicalText.equals(new String(disk, StandardCharsets.UTF_8));
        return new EditorView(loaded, tree(canonicalText), sha256(disk), canonical, editable,
                outcomes(playbook), choices(playbook, config, providers));
    }

    /**
     * The view of the file in the folder {@code dir} as it is on disk. A file
     * that is missing, not a regular file or above {@link PlaybookLoader#MAX_BYTES}
     * is answered as {@link PlaybookLoader#load} answers it: no playbook, the
     * finding, not editable, and the hash of no bytes.
     */
    static EditorView ofDisk(Path dir, Path workspace, SpectroConfig config) {
        Path file = dir.resolve(PlaybookFolders.PLAYBOOK_FILE);
        try {
            if (Files.isRegularFile(file) && Files.size(file) <= PlaybookLoader.MAX_BYTES) {
                byte[] disk = Files.readAllBytes(file);
                return of(dir, new String(disk, StandardCharsets.UTF_8), disk, workspace, config);
            }
        } catch (IOException unreadable) {
            // answered below as the loader answers it
        }
        PlaybookLoader.Loaded refused = PlaybookLoader.load(dir, workspace, config);
        return new EditorView(refused, null, sha256(new byte[0]), false, false, Map.of(), List.of());
    }

    /** The sha256 of {@code bytes} as lowercase hex. */
    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("every JDK has SHA-256", impossible);
        }
    }

    private static JsonNode tree(String canonicalText) {
        if (canonicalText == null) {
            return null;
        }
        try {
            return JSON.readTree(canonicalText);
        } catch (IOException cannotHappen) {
            throw new IllegalStateException("the canonical writer wrote invalid JSON", cannotHappen);
        }
    }

    private static Map<String, List<String>> outcomes(Playbook playbook) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        if (playbook == null) {
            return out;
        }
        for (Playbook.Node n : playbook.nodes()) {
            if (!(n instanceof Playbook.End)) {
                out.put(n.id(), List.copyOf(PlaybookValidator.outcomesOf(playbook, n)));
            }
        }
        return out;
    }

    private static List<ChoiceState> choices(Playbook playbook, SpectroConfig config, ProviderStates providers) {
        List<ChoiceState> out = new ArrayList<>();
        if (playbook == null) {
            return out;
        }
        for (Map.Entry<String, Playbook.ModelChoice> e : playbook.models().entrySet()) {
            Playbook.ModelRef primary = e.getValue().primary();
            if (primary == null) {
                out.add(new ChoiceState(e.getKey(), null, null, "unknown", "the choice names no primary model"));
                continue;
            }
            ProviderStates.State state = providers.of(primary.provider(), primary.model(), config);
            out.add(new ChoiceState(e.getKey(), primary.provider(), primary.model(), state.state(), state.reason()));
        }
        return out;
    }
}
