package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * What the playbook installer put on this machine, kept in
 * {@code ~/.spectro/playbook-installs.json} as {@code {"installs":[...]}}, one
 * entry per playbook id. The ledger is how a later run knows which copies
 * belong to a playbook, which files the installer generated beside them, and
 * which contents hash the install was made from.
 *
 * <p>Writes go to a temp file in the same directory and are moved into place
 * atomically. A file that does not parse is never overwritten: every
 * operation, reads included, throws {@link IllegalStateException} naming it.
 */
public final class InstallLedger {

    /**
     * One installed content. {@code generated} lists the relative paths the
     * installer wrote beside the copy (licence, provenance, record), so the
     * copy hash skips exactly those. {@code entry} is the resolved hook entry
     * for kind {@code hook}, null otherwise.
     */
    public record Item(String kind, String name, String source, String sha256, String target,
                       List<String> generated, Map<String, Object> entry) {
        public Item {
            generated = generated == null ? List.of() : List.copyOf(generated);
            entry = entry == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(entry));
        }
    }

    /** All items one playbook brought, with the folder and the hash they came from. */
    public record Install(String playbook, String dir, String contentsHash, String installedOn, List<Item> items) {
        public Install {
            items = items == null ? List.of() : List.copyOf(items);
        }
    }

    private static final ObjectMapper JSON = new ObjectMapper().enable(SerializationFeature.INDENT_OUTPUT);
    private static final TypeReference<List<Install>> INSTALLS = new TypeReference<>() {};

    private final Path file;

    public InstallLedger(Path file) {
        this.file = file;
    }

    /** The ledger in the operator's home, {@code ~/.spectro/playbook-installs.json}. */
    public static InstallLedger inHome() {
        return new InstallLedger(Path.of(System.getProperty("user.home"), ".spectro", "playbook-installs.json"));
    }

    /** Every recorded install; a missing file reads as empty. */
    public synchronized List<Install> all() {
        return List.copyOf(load());
    }

    public synchronized Optional<Install> find(String playbookId) {
        return load().stream().filter(i -> i.playbook().equals(playbookId)).findFirst();
    }

    /**
     * @param playbookId the playbook id
     * @param kind       skill, command, hook, agent or workflow
     * @param source     the playbook relative path the item was installed from
     * @return the sha256 the install of that playbook recorded for that item, or null when it recorded none
     */
    public synchronized String itemHash(String playbookId, String kind, String source) {
        return load().stream().filter(i -> i.playbook().equals(playbookId))
                .flatMap(i -> i.items().stream())
                .filter(item -> item.kind().equals(kind) && item.source().equals(source))
                .map(Item::sha256).findFirst().orElse(null);
    }

    /** Records an install, replacing the entry of the same playbook id in place. */
    public synchronized void put(Install install) {
        List<Install> next = new ArrayList<>(load());
        boolean replaced = false;
        for (int i = 0; i < next.size(); i++) {
            if (next.get(i).playbook().equals(install.playbook())) {
                next.set(i, install);
                replaced = true;
                break;
            }
        }
        if (!replaced) next.add(install);
        write(next);
    }

    /** Forgets one playbook. An id that was never recorded changes nothing. */
    public synchronized void drop(String playbookId) {
        List<Install> current = load();
        List<Install> next = new ArrayList<>(current);
        if (next.removeIf(i -> i.playbook().equals(playbookId))) write(next);
    }

    private List<Install> load() {
        if (!Files.exists(file)) return List.of();
        try {
            JsonNode root = JSON.readTree(Files.readString(file, StandardCharsets.UTF_8));
            if (root == null || !root.isObject()) throw new IllegalArgumentException("not a JSON object");
            JsonNode installs = root.get("installs");
            if (installs == null) return List.of();
            if (!installs.isArray()) throw new IllegalArgumentException("\"installs\" is not a list");
            return JSON.convertValue(installs, INSTALLS);
        } catch (IOException | IllegalArgumentException broken) {
            throw new IllegalStateException(
                    "The install ledger " + file + " cannot be read and was left untouched: " + broken.getMessage(), broken);
        }
    }

    private void write(List<Install> installs) {
        Path temp = null;
        try {
            Path dir = file.toAbsolutePath().getParent();
            Files.createDirectories(dir);
            temp = Files.createTempFile(dir, file.getFileName() + ".", ".tmp");
            ObjectNode root = JSON.createObjectNode();
            root.set("installs", JSON.valueToTree(installs));
            Files.writeString(temp, JSON.writeValueAsString(root), StandardCharsets.UTF_8);
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            temp = null;
        } catch (IOException e) {
            throw new UncheckedIOException("Cannot write the install ledger " + file, e);
        } finally {
            if (temp != null) {
                try {
                    Files.deleteIfExists(temp);
                } catch (IOException ignored) {
                    // The temp file is beside the ledger and harmless; the write error is what matters.
                }
            }
        }
    }
}
