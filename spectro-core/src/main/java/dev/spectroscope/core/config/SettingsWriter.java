package dev.spectroscope.core.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Set;

/**
 * The one writer for every settings file the settings-productization API touches.
 * Two capabilities:
 *
 * <p>{@link #appendAutoApprove} appends an {@code autoApprove} rule into
 * {@code <cwd>/.spectro/settings.json} — the persist path behind a web "always allow ·
 * dauerhaft" click. Read-modify-write with the shared mapper: every other key
 * (mcpServers, hooks, machine-local paths) is preserved, the array is deduped, and the
 * file is created (with its {@code .spectro/} dir) if absent. Because this writes the
 * file the CLI {@link dev.spectroscope.core.permission.Allowlist} already reads, a web decision
 * is honored by the CLI on its next run — the shared-allowlist point.</p>
 *
 * <p>{@link #patch} applies a schema-validated, shallow, per-top-level-key merge
 * against any settings file in any {@link Scope} — the settings API's PUT endpoint
 * (Tasks 9/10) calls this so a user/project/local write can never brick the file
 * {@link SpectroConfig#load} later reads.</p>
 *
 * <p>{@code SpectroConfig} only reads settings; this is the sole writer.</p>
 *
 * <p>{@code synchronized}: two browser tabs on the same project are two socket
 * connections in ONE server JVM — an unserialized read-modify-write would let the
 * second persist click overwrite the first (last-writer-wins, one rule lost). A
 * concurrent writer in another process (a future CLI persist path) stays a known
 * residual; that would need an OS file lock.</p>
 */
public final class SettingsWriter {

    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * A settings scope, mirroring the file-hierarchy layers {@link SpectroConfig}
     * folds ({@code USER} = {@code ~/.spectro/settings.json}, {@code PROJECT}/
     * {@code LOCAL} = a workspace's own {@code .spectro/settings(.local).json}).
     * {@link #patch} refuses process-global fields ({@code workspace}, {@code
     * logLevel}) in {@code PROJECT}/{@code LOCAL} — those stay {@code USER}-only.
     */
    public enum Scope { USER, PROJECT, LOCAL }

    /** Every settings key {@link #patch} accepts — mirrors {@link SpectroConfig}'s
     *  17 record components exactly; anything else is refused as unknown. */
    private static final Set<String> KNOWN_KEYS = Set.of(
            "provider", "model", "baseUrl", "compactionThreshold", "permissionMode",
            "autoApprove", "imageProvider", "thinking", "mcpServers", "maxRetries",
            "promptCaching", "hooks", "workspace", "logLevel",
            "imageModel", "sttModel", "chromeBinary");

    /** Fields that apply to the whole process, not one workspace — a
     *  {@code PROJECT}/{@code LOCAL} patch setting either is refused. This is the
     *  write-side twin of {@code SpectroConfig}'s own {@code rejectProcessGlobals},
     *  which rejects the same two fields when reading a workspace scope. */
    private static final Set<String> PROCESS_GLOBALS = Set.of("workspace", "logLevel");

    /** Static utility — never instantiated. */
    private SettingsWriter() {
    }

    /**
     * Idempotently appends one rule to the {@code autoApprove} array of the project
     * settings — duplicates are skipped, every other key in the file survives, and
     * the file plus its {@code .spectro/} directory are created when absent.
     *
     * @param cwd  the project root whose {@code .spectro/settings.json} is written
     * @param rule the allowlist entry to persist, e.g. {@code "run_command:git status*"}
     * @throws IOException when the settings file cannot be read or written
     */
    public static synchronized void appendAutoApprove(Path cwd, String rule) throws IOException {
        Path file = cwd.resolve(SpectroConfig.PROJECT_SETTINGS);
        ObjectNode root;
        if (Files.exists(file)) {
            JsonNode tree = JSON.readTree(Files.readString(file, StandardCharsets.UTF_8));
            root = tree.isObject() ? (ObjectNode) tree : JSON.createObjectNode();
        } else {
            root = JSON.createObjectNode();
        }
        ArrayNode approve = root.has("autoApprove") && root.get("autoApprove").isArray()
                ? (ArrayNode) root.get("autoApprove")
                : JSON.createArrayNode();
        boolean present = false;
        for (JsonNode entry : approve) {
            if (rule.equals(entry.asText())) {
                present = true;
                break;
            }
        }
        if (!present) {
            approve.add(rule);
        }
        root.set("autoApprove", approve);
        writeAtomically(file, JSON.writerWithDefaultPrettyPrinter().writeValueAsString(root));
    }

    /** The user scope's file — the ONE place its path is answered for writers.
     *  @return {@code ~/.spectro/settings.json} */
    public static Path userSettingsFile() {
        return SpectroConfig.USER_SETTINGS_PATH;
    }

    /**
     * Applies a schema-validated, shallow, per-top-level-key merge to a settings
     * file: every key in {@code patch} either overwrites (or adds) that key in the
     * file, or — when its value is JSON {@code null} — removes it. Every other key
     * already in the file, known or not (e.g. the CLI-side {@code tts} block),
     * survives untouched. The patch is validated BEFORE any file is touched: unknown
     * keys, secret-shaped keys ({@code *_API_KEY}/{@code *_TOKEN}), process-globals
     * ({@code workspace}/{@code logLevel}) in a {@code PROJECT}/{@code LOCAL} scope,
     * and values of the wrong shape all throw {@link IllegalArgumentException}
     * without writing anything. The file must still bind as a whole after the merge
     * — this is what stops a patch from bricking a settings file that {@link
     * SpectroConfig#load} would then fail to read on every subsequent boot. A
     * {@code LOCAL} write additionally ensures the settings directory's
     * {@code .gitignore} carries {@code settings.local.json} (idempotent).
     *
     * @param file  the settings file to read-modify-write, created (with its
     *              parent directory) if absent
     * @param scope which scope {@code file} represents — governs the
     *              process-global rejection
     * @param patch a flat JSON object; a {@code null}-valued entry removes that key
     * @throws IOException              when the file cannot be read or written
     * @throws IllegalArgumentException when the patch fails validation; nothing
     *                                  is written in that case
     */
    public static synchronized void patch(Path file, Scope scope, JsonNode patch) throws IOException {
        if (patch == null || !patch.isObject()) {
            throw new IllegalArgumentException("settings patch must be a JSON object");
        }
        validate(scope, (ObjectNode) patch);

        JsonNode existing = Files.exists(file) ? JSON.readTree(Files.readString(file)) : null;
        ObjectNode root = existing instanceof ObjectNode obj ? obj : JSON.createObjectNode();
        patch.properties().forEach(entry -> {
            if (entry.getValue() == null || entry.getValue().isNull()) {
                root.remove(entry.getKey());
            } else {
                root.set(entry.getKey(), entry.getValue());
            }
        });
        // The file must stay loadable as a whole — a bricked settings file would
        // take down EVERY subsequent load across all faces (validated pre-write).
        bindOrThrow(root);

        Files.createDirectories(file.getParent());
        if (scope == Scope.LOCAL) {
            ensureLocalGitignore(file.getParent());
        }
        writeAtomically(file, JSON.writerWithDefaultPrettyPrinter().writeValueAsString(root));
    }

    /** Rejects an invalid patch before {@link #patch} touches the file: unknown
     *  keys, secret-shaped keys, process-globals in a workspace scope, and known-
     *  value fields outside their allowed set (per key), then a full shape check
     *  of what would actually be written (removals excluded — a {@code null} need
     *  not match the field's real type).
     *  @param scope the scope {@code patch} is being applied to
     *  @param patch the flat JSON object to validate
     *  @throws IllegalArgumentException on the first violation found */
    private static void validate(Scope scope, ObjectNode patch) {
        patch.properties().forEach(entry -> {
            String key = entry.getKey();
            String upper = key.toUpperCase(java.util.Locale.ROOT);
            if (upper.endsWith("_API_KEY") || upper.endsWith("_TOKEN")) {
                throw new IllegalArgumentException("secrets never enter settings files — keep \""
                        + key + "\" in .env or the shell environment");
            }
            if (!KNOWN_KEYS.contains(key)) {
                throw new IllegalArgumentException("unknown settings key \"" + key
                        + "\" (known: " + String.join(", ", KNOWN_KEYS.stream().sorted().toList()) + ")");
            }
            if (scope != Scope.USER && PROCESS_GLOBALS.contains(key)) {
                throw new IllegalArgumentException("\"" + key + "\" is "
                        + ("workspace".equals(key) ? "circular" : "process-global")
                        + " and not allowed in a workspace scope — set it in the user settings");
            }
            JsonNode value = entry.getValue();
            if (value != null && !value.isNull()) {
                checkKnownValue(key, value);
            }
        });
        ObjectNode probe = patch.deepCopy();
        probe.properties().removeIf(e -> e.getValue() == null || e.getValue().isNull());
        bindOrThrow(probe);   // type check the patch itself (int fields, list shapes, block shapes)
    }

    /** Checks a single field's value against its known-value set, for the fields
     *  that have one; every other key's value shape is checked generically by
     *  {@link #bindOrThrow} instead.
     *  @param key   the settings key being set
     *  @param value the (non-null) value being set for it
     *  @throws IllegalArgumentException when the value is outside the known set */
    private static void checkKnownValue(String key, JsonNode value) {
        switch (key) {
            case "provider" -> requireOneOf(key, value.asText(), SpectroConfig.KNOWN_PROVIDERS);
            case "imageProvider" -> requireOneOf(key, value.asText(), SpectroConfig.KNOWN_IMAGE_PROVIDERS);
            case "logLevel" -> requireOneOf(key, value.asText(), SpectroConfig.KNOWN_LOG_LEVELS);
            case "permissionMode" -> requireOneOf(key, value.asText(), SpectroConfig.KNOWN_PERMISSION_MODES);
            default -> { }
        }
    }

    /** Fails loudly when {@code value} is outside {@code known} — mirrors {@code
     *  SpectroConfig}'s own {@code validateKnown}, on the write side.
     *  @param key   the settings key, named in the message
     *  @param value the value being checked
     *  @param known the allowed values for {@code key}
     *  @throws IllegalArgumentException when {@code value} is not in {@code known} */
    private static void requireOneOf(String key, String value, Set<String> known) {
        if (!known.contains(value)) {
            throw new IllegalArgumentException("unknown " + key + " \"" + value
                    + "\" (allowed: " + String.join(", ", known.stream().sorted().toList()) + ")");
        }
    }

    /** Binds {@code root} against {@link SpectroConfig}'s partial-config shape,
     *  turning any Jackson binding failure into a readable {@link
     *  IllegalArgumentException} — the one place a wrong-shaped value (e.g. a
     *  string where {@code compactionThreshold} wants an int) is caught before
     *  a write, instead of surfacing as a raw Jackson stack trace on the next load.
     *  @param root the JSON object to bind; unknown keys are ignored (foreign
     *              blocks like {@code tts} survive), known keys must fit their shape
     *  @throws IllegalArgumentException when {@code root} does not bind */
    private static void bindOrThrow(ObjectNode root) {
        try {
            JSON.treeToValue(root, SpectroConfig.PartialConfig.class);
        } catch (com.fasterxml.jackson.core.JsonProcessingException wrongShape) {
            throw new IllegalArgumentException("settings value has the wrong shape: "
                    + wrongShape.getOriginalMessage());
        }
    }

    /**
     * Writes {@code content} to {@code file} atomically: a temp file in the
     * SAME directory (so the final rename stays on one filesystem, never
     * crossing a mount point), then one {@code ATOMIC_MOVE}. A racing reader —
     * another connection's config load, or {@code spectroscope doctor} running at the
     * same moment — can only ever observe the untouched old file or the fully
     * written new one, never a half-written partial file.
     *
     * @param file    the settings file to replace (created if absent)
     * @param content the complete new file content
     * @throws IOException when the temp file cannot be written or the move fails
     */
    private static void writeAtomically(Path file, String content) throws IOException {
        Path dir = file.getParent();
        Files.createDirectories(dir);
        Path temp = Files.createTempFile(dir, "." + file.getFileName() + ".", ".tmp");
        try {
            Files.writeString(temp, content, StandardCharsets.UTF_8);
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException failure) {
            Files.deleteIfExists(temp);
            throw failure;
        }
    }

    /** Ensures {@code <spectroDir>/.gitignore} lists {@code settings.local.json},
     *  creating the file (with just that line) or appending to it exactly once —
     *  a repeat call never duplicates the line.
     *  @param spectroDir the {@code .spectro} directory the local settings file lives in
     *  @throws IOException when the gitignore cannot be read or written */
    private static void ensureLocalGitignore(Path spectroDir) throws IOException {
        Path gitignore = spectroDir.resolve(".gitignore");
        Files.createDirectories(spectroDir);
        if (!Files.exists(gitignore)) {
            Files.writeString(gitignore, "settings.local.json\n");
            return;
        }
        if (Files.readString(gitignore).lines().noneMatch("settings.local.json"::equals)) {
            Files.writeString(gitignore, Files.readString(gitignore) + "settings.local.json\n");
        }
    }
}
