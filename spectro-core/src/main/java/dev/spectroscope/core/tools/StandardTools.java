package dev.spectroscope.core.tools;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.tools.Tool.ToolContext;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.PathMatcher;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/** The built-in tool belt, as registrable {@link Tool} objects. */
public final class StandardTools {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final long MAX_FILE_BYTES = 50_000;
    private static final int MAX_OUTPUT_CHARS = ToolOutput.MAX_OUTPUT_CHARS;
    private static final int MAX_GLOB_RESULTS = 200;
    private static final long COMMAND_TIMEOUT_SECONDS = 10;

    /** Directories skipped by grep/glob tree walks — build noise, never source. */
    private static final Set<String> IGNORED_DIRS = Set.of(".git", "build", "node_modules", "target");

    /** Static factory — no instances. */
    private StandardTools() {}

    /**
     * All standard tools; register each into a {@link ToolRegistry}.
     *
     * @return list_dir, read_file, write_file, run_command, edit_file, glob, grep,
     *         view_image and view_file
     */
    public static List<Tool> all() {
        return all(COMMAND_TIMEOUT_SECONDS);
    }

    /**
     * Visible for tests: the command timeout is the only knob worth turning there.
     *
     * @param commandTimeoutSeconds run_command's wall-clock budget — timeout tests shrink it
     * @return the same tool set with the given timeout wired into run_command
     */
    static List<Tool> all(long commandTimeoutSeconds) {
        return List.of(listDir(), readFile(), writeFile(), runCommand(commandTimeoutSeconds),
                editFile(), glob(), grep(), viewImage(), viewFile());
    }

    // ---- view_file (file_upload, additive) -----------------------------------------------

    /** The providers' practical per-document limit — Anthropic's request cap is ~32 MB
     *  total and base64 inflates by a third, so 10 MB source keeps requests healthy. */
    private static final long MAX_DOCUMENT_BYTES = 10L * 1024 * 1024;

    /**
     * Builds {@code view_file}: shows the model a DOCUMENT from the workspace —
     * a PDF is read inside the sandbox, base64-encoded and handed to the loop
     * through the same attach sink view_image uses; the loop appends it to this
     * tool result's user message, so the document rides to the provider with
     * the next request (anthropic: document block; openai: file part; ollama
     * fails fast with a pointer). Read-only: no gate.
     *
     * @return the view_file tool
     */
    private static Tool viewFile() {
        return new Tool() {
            /** Wire name: {@code view_file}. */
            public String name() { return "view_file"; }
            /** The model-facing one-liner — names the type, the limit and the siblings. */
            public String description() {
                return "Shows you a document file from the working directory (pdf, max 10 MB)"
                        + " — the document is uploaded to the model with this result so you"
                        + " can read it. Use read_file for text files and view_image for images.";
            }
            /** One required string: {@code path}. */
            public JsonNode inputSchema() { return schemaWithRequired("path"); }
            /** Read-only inside the sandbox — no gate. */
            public boolean needsPermission() { return false; }

            /** Attaches the sandboxed PDF; failures as "ERROR: ". */
            public String execute(JsonNode input, ToolContext context) {
                try {
                    Path file = resolveInside(context.cwd(), input.path("path").asText());
                    String fileName = file.getFileName().toString();
                    if (!fileName.toLowerCase(Locale.ROOT).endsWith(".pdf")) {
                        return "ERROR: view_file reads pdf documents only — use read_file"
                                + " for text files and view_image for images.";
                    }
                    long size = Files.size(file);
                    if (size > MAX_DOCUMENT_BYTES) {
                        return "ERROR: document too large (" + size + " bytes, limit "
                                + MAX_DOCUMENT_BYTES + " = 10 MB).";
                    }
                    context.attach().accept(new Tool.AttachedDocument("application/pdf",
                            Base64.getEncoder().encodeToString(Files.readAllBytes(file)),
                            fileName));
                    return "Attached " + fileName + " (application/pdf, " + size
                            + " bytes) — the document is included with this result for you to read.";
                } catch (IOException | RuntimeException error) {
                    return "ERROR: " + error.getMessage();
                }
            }
        };
    }

    // ---- view_image (additive) -----------------------------------------------

    /** The image types the vision path accepts — the attachment set. */
    private static final Map<String, String> IMAGE_MEDIA_TYPES = Map.of(
            "png", "image/png", "jpg", "image/jpeg", "jpeg", "image/jpeg",
            "webp", "image/webp", "gif", "image/gif");

    /** The providers' per-image wire limit — the ladder itself moved to the
     *  shared {@link dev.spectroscope.core.image.ImageDownscaler} (file_upload: the
     *  composer attachment path applies the same policy). */
    private static final long WIRE_IMAGE_LIMIT_BYTES =
            dev.spectroscope.core.image.ImageDownscaler.WIRE_IMAGE_LIMIT_BYTES;

    /** Sanity cap on the SOURCE file — beyond this, even downscaling is refused. */
    private static final long MAX_SOURCE_IMAGE_BYTES = 50L * 1024 * 1024;

    /**
     * Builds {@code view_image}: shows the model an image FROM THE WORKSPACE —
     * the file is read inside the sandbox, base64-encoded and handed to the
     * loop through the context's attach sink; the loop appends it to this tool
     * result's user message, so the image rides to the provider (cloud or
     * local vision model) with the next request. Read-only: no gate.
     *
     * @return the view_image tool
     */
    private static Tool viewImage() {
        return new Tool() {
            /** Wire name: {@code view_image}. */
            public String name() { return "view_image"; }
            /** The model-facing one-liner — names the types and the auto-downscale. */
            public String description() {
                return "Shows you an image file from the working directory (png, jpg, webp, "
                        + "gif) — the image is uploaded to the model with this result so you "
                        + "can describe or analyze it. Large photos are downscaled automatically.";
            }
            /** One required string: {@code path}. */
            public JsonNode inputSchema() { return schemaWithRequired("path"); }
            /** Read-only inside the sandbox — no gate. */
            public boolean needsPermission() { return false; }

            /** Attaches the (possibly downscaled) image; failures as "ERROR: ". */
            public String execute(JsonNode input, ToolContext context) {
                try {
                    String rawPath = input.path("path").asText();
                    Path file = resolveInside(context.cwd(), rawPath);
                    String name = file.getFileName().toString();
                    int dot = name.lastIndexOf('.');
                    String mediaType = dot < 0 ? null
                            : IMAGE_MEDIA_TYPES.get(name.substring(dot + 1).toLowerCase());
                    if (mediaType == null) {
                        return "ERROR: not a supported image type (png, jpg, jpeg, webp, gif): "
                                + name + " — convert HEIC/others first (e.g. sips -s format jpeg).";
                    }
                    long size = Files.size(file);
                    if (size > MAX_SOURCE_IMAGE_BYTES) {
                        return "ERROR: image too large even for downscaling (" + size
                                + " bytes, limit " + MAX_SOURCE_IMAGE_BYTES + ").";
                    }
                    if (size <= WIRE_IMAGE_LIMIT_BYTES) {
                        // Fits the providers' per-image limit: attach the bytes verbatim.
                        context.attach().accept(new Tool.AttachedImage(
                                mediaType, Base64.getEncoder().encodeToString(Files.readAllBytes(file))));
                        return "Attached " + name + " (" + mediaType + ", " + size
                                + " bytes) — the image is included with this result for you to see.";
                    }
                    // Bigger than the wire allows (iPhone photos easily exceed 5 MB):
                    // downscale instead of refusing — the providers reject the original.
                    dev.spectroscope.core.image.ImageDownscaler.Result scaled =
                            dev.spectroscope.core.image.ImageDownscaler.downscaleToWireLimit(
                                    Files.readAllBytes(file), mediaType);
                    context.attach().accept(new Tool.AttachedImage(
                            scaled.mediaType(), Base64.getEncoder().encodeToString(scaled.bytes())));
                    return "Attached " + name + " (" + size + " bytes source, downscaled to "
                            + scaled.width() + "x" + scaled.height() + " " + scaled.mediaType()
                            + ", " + scaled.bytes().length
                            + " bytes for the provider's 5 MB image limit) — included for you to see.";
                } catch (IOException | RuntimeException error) {
                    return "ERROR: " + error.getMessage();
                }
            }
        };
    }

    // ---- path sandbox: tool inputs are model output and therefore untrusted -----------

    /**
     * The path sandbox: resolves a model-supplied relative path and rejects any
     * result outside cwd with an IOException — ".." traversal must not escape.
     *
     * @param cwd      the sandbox root (the agent's working directory)
     * @param relative the path string exactly as the model sent it
     * @return the normalized absolute path, guaranteed inside cwd
     */
    private static Path resolveInside(Path cwd, String relative) throws IOException {
        Path base = cwd.toAbsolutePath().normalize();
        Path resolved = base.resolve(relative).normalize();
        if (!resolved.equals(base) && !resolved.startsWith(base + File.separator)) {
            throw new IOException("path is outside the working directory: " + relative);
        }
        return resolved;
    }

    /**
     * A minimal JSON-Schema object with one required string property.
     *
     * @param property name of the single required string field
     * @return the schema tree, ready to serve from inputSchema()
     */
    private static JsonNode schemaWithRequired(String property) {
        ObjectNode schema = JSON.createObjectNode();
        schema.put("type", "object");
        ObjectNode properties = JSON.createObjectNode();
        properties.set(property, JSON.createObjectNode().put("type", "string"));
        schema.set("properties", properties);
        ArrayNode required = JSON.createArrayNode();
        required.add(property);
        schema.set("required", required);
        return schema;
    }

    // ---- list_dir ----------------------------------------------------------------------

    /** Builds {@code list_dir}: names the entries of one sandboxed directory — read-only, permission-free. */
    private static Tool listDir() {
        return new Tool() {
            /** Wire name: {@code list_dir}. */
            public String name() { return "list_dir"; }
            /** The model-facing one-liner. */
            public String description() { return "Lists the entries of a directory relative to the working directory."; }
            /** One required string: {@code path}. */
            public JsonNode inputSchema() { return schemaWithRequired("path"); }
            /** Read-only inside the sandbox — no gate. */
            public boolean needsPermission() { return false; }

            /** Lists the resolved directory — sorted, directories marked with a trailing slash; failures as "ERROR: ". */
            public String execute(JsonNode input, ToolContext context) {
                try {
                    Path dir = resolveInside(context.cwd(), input.path("path").asText());
                    try (Stream<Path> entries = Files.list(dir)) {
                        String listing = entries
                                .map(entry -> Files.isDirectory(entry)
                                        ? entry.getFileName() + "/"
                                        : entry.getFileName().toString())
                                .sorted()
                                .collect(Collectors.joining("\n"));
                        return listing.isEmpty() ? "(empty)" : listing;
                    }
                } catch (IOException | RuntimeException error) {
                    return "ERROR: " + error.getMessage();
                }
            }
        };
    }

    // ---- read_file ---------------------------------------------------------------------

    /**
     * Builds {@code read_file}: returns a sandboxed text file whole (refusing
     * anything over the size limit), or — file_upload — a PAGED window of a
     * file of any size via the optional {@code offset} (1-based line) and
     * {@code limit} (line count) parameters. The 50 kB bound then applies to
     * the WINDOW instead of the file, so big logs and datasets stay reachable.
     */
    private static Tool readFile() {
        return new Tool() {
            /** Wire name: {@code read_file}. */
            public String name() { return "read_file"; }
            /** The model-facing one-liner — announces the cap AND the paging escape. */
            public String description() {
                return "Reads a text file (max 50 kB at once) relative to the working "
                        + "directory. Larger files: page with offset (1-based line) and "
                        + "limit (line count).";
            }
            /** Required {@code path}; optional integers {@code offset} and {@code limit}. */
            public JsonNode inputSchema() {
                ObjectNode schema = JSON.createObjectNode();
                schema.put("type", "object");
                ObjectNode properties = JSON.createObjectNode();
                properties.set("path", JSON.createObjectNode().put("type", "string"));
                properties.set("offset", JSON.createObjectNode().put("type", "integer")
                        .put("description", "first line to read, 1-based (enables paging)"));
                properties.set("limit", JSON.createObjectNode().put("type", "integer")
                        .put("description", "how many lines to read from offset"));
                schema.set("properties", properties);
                schema.set("required", JSON.createArrayNode().add("path"));
                return schema;
            }
            /** Read-only inside the sandbox — no gate. */
            public boolean needsPermission() { return false; }

            /** Whole file or paged window after the sandbox and size checks; failures as "ERROR: ". */
            public String execute(JsonNode input, ToolContext context) {
                try {
                    Path file = resolveInside(context.cwd(), input.path("path").asText());
                    int offset = input.path("offset").asInt(0);
                    int limit = input.path("limit").asInt(0);
                    if (offset <= 0 && limit <= 0) {
                        // Whole-file read — the pre-paging contract, unchanged.
                        long size = Files.size(file);
                        if (size > MAX_FILE_BYTES) {
                            return "ERROR: file too large (" + size + " bytes, limit "
                                    + MAX_FILE_BYTES + ") — page with offset/limit.";
                        }
                        return Files.readString(file, StandardCharsets.UTF_8);
                    }
                    // Paged window: lines stream lazily, so file size stops mattering.
                    long fromLine = Math.max(1, offset);
                    long count = limit > 0 ? limit : Long.MAX_VALUE;
                    String window;
                    try (Stream<String> lines = Files.lines(file, StandardCharsets.UTF_8)) {
                        window = lines.skip(fromLine - 1).limit(count)
                                .collect(Collectors.joining("\n"));
                    }
                    if (window.length() > MAX_FILE_BYTES) {
                        return "ERROR: window too large (" + window.length()
                                + " chars, limit " + MAX_FILE_BYTES + ") — reduce limit.";
                    }
                    return window.isEmpty() ? "(no lines in that window)" : window;
                } catch (IOException | RuntimeException error) {
                    return "ERROR: " + error.getMessage();
                }
            }
        };
    }

    // ---- write_file (additive) --------------------------------------------------

    /** Builds {@code write_file}: creates or overwrites a sandboxed text file — a mutation, therefore permission-gated. */
    private static Tool writeFile() {
        return new Tool() {
            /** Wire name: {@code write_file}. */
            public String name() { return "write_file"; }
            /** The model-facing one-liner — mentions the directory auto-create. */
            public String description() {
                return "Writes a text file relative to the working directory "
                        + "(creates directories as needed).";
            }
            /** Two required strings: {@code path} and {@code content}. */
            public JsonNode inputSchema() {
                // Two required strings — built as a Jackson tree like the other schemas.
                ObjectNode schema = JSON.createObjectNode();
                schema.put("type", "object");
                ObjectNode properties = JSON.createObjectNode();
                properties.set("path", JSON.createObjectNode().put("type", "string"));
                properties.set("content", JSON.createObjectNode().put("type", "string"));
                schema.set("properties", properties);
                schema.set("required", JSON.createArrayNode().add("path").add("content"));
                return schema;
            }
            /** Mandatory: tool inputs are model output and therefore untrusted — a write
             *  is guarded exactly like run_command, no special case. */
            public boolean needsPermission() { return true; }

            /** Sandbox-resolves the path, creates parent directories and writes the content — answers with the byte count. */
            public String execute(JsonNode input, ToolContext context) {
                try {
                    String relative = input.path("path").asText();
                    String content = input.path("content").asText();
                    Path file = resolveInside(context.cwd(), relative); // path sandbox
                    Files.createDirectories(file.getParent());
                    Files.writeString(file, content, StandardCharsets.UTF_8);
                    int bytes = content.getBytes(StandardCharsets.UTF_8).length;
                    return "Wrote: " + relative + " (" + bytes + " bytes)";
                } catch (IOException | RuntimeException error) {
                    return "ERROR: " + error.getMessage(); // never throw out of a tool
                }
            }
        };
    }

    // ---- run_command -------------------------------------------------------------------

    /**
     * Builds {@code run_command}: one shell line through {@link ShellCommand},
     * permission-gated — arbitrary execution is the sharpest tool in the belt.
     *
     * @param timeoutSeconds wall-clock budget per call; tests shrink it
     */
    private static Tool runCommand(long timeoutSeconds) {
        return new Tool() {
            /** Wire name: {@code run_command}. */
            public String name() { return "run_command"; }
            /** The model-facing one-liner — announces timeout and truncation. */
            public String description() { return "Runs a shell command in the working directory (10 s timeout, output truncated)."; }
            /** One required string: {@code command}. */
            public JsonNode inputSchema() { return schemaWithRequired("command"); }
            /** Guarded — arbitrary shell execution always passes the permission gate. */
            public boolean needsPermission() { return true; } // the only guarded tool

            /** Delegates to ShellCommand and maps its Result onto the tool convention — timeout, spawn failure and non-zero exit become "ERROR: " strings. */
            public String execute(JsonNode input, ToolContext context) {
                String command = input.path("command").asText();
                ShellCommand.Result result = ShellCommand.run(command, Map.of(), context.cwd(),
                        timeoutSeconds, context.signal(), MAX_OUTPUT_CHARS);
                if (result.timedOut()) {
                    return "ERROR: command timed out after " + timeoutSeconds + " s.";
                }
                if (result.failure() != null) {
                    return "interrupted".equals(result.failure())
                            ? "ERROR: command was interrupted."
                            : "ERROR: " + result.failure();
                }
                // A non-zero exit is feedback the model needs for self-correction
                // (a killed process — cancel — lands here too, as 137/143).
                if (result.exitCode() != 0) {
                    return "ERROR: exit code " + result.exitCode()
                            + (result.output().isBlank() ? "" : "\n" + result.output());
                }
                return result.output().isEmpty() ? "(no output)" : result.output();
            }
        };
    }

    // ---- edit_file (real tool: exact-string replace, permission-gated) -----

    /** Builds {@code edit_file}: exact-string replacement with a uniqueness guard — a mutation, permission-gated like write_file. */
    private static Tool editFile() {
        return new Tool() {
            /** Wire name: {@code edit_file}. */
            public String name() { return "edit_file"; }
            /** The model-facing one-liner — states the uniqueness rule. */
            public String description() {
                return "Replaces an exact string in a text file relative to the working "
                        + "directory. old_string must be unique unless replace_all is true.";
            }
            /** Required {@code path}, {@code old_string}, {@code new_string}; optional boolean {@code replace_all}. */
            public JsonNode inputSchema() {
                ObjectNode schema = JSON.createObjectNode();
                schema.put("type", "object");
                ObjectNode properties = JSON.createObjectNode();
                properties.set("path", JSON.createObjectNode().put("type", "string"));
                properties.set("old_string", JSON.createObjectNode().put("type", "string"));
                properties.set("new_string", JSON.createObjectNode().put("type", "string"));
                properties.set("replace_all", JSON.createObjectNode().put("type", "boolean"));
                schema.set("properties", properties);
                schema.set("required", JSON.createArrayNode()
                        .add("path").add("old_string").add("new_string"));
                return schema;
            }
            /** A mutation, guarded exactly like write_file — tool input is untrusted. */
            public boolean needsPermission() { return true; }

            /** Applies the exact-string replacement after sandbox, size, presence and uniqueness checks. */
            public String execute(JsonNode input, ToolContext context) {
                try {
                    String relative = input.path("path").asText();
                    String oldString = input.path("old_string").asText();
                    String newString = input.path("new_string").asText();
                    boolean replaceAll = input.path("replace_all").asBoolean(false);
                    if (oldString.isEmpty()) {
                        return "ERROR: old_string must be non-empty (use write_file to create a file).";
                    }
                    Path file = resolveInside(context.cwd(), relative); // path sandbox
                    long size = Files.size(file);
                    if (size > MAX_FILE_BYTES) {
                        return "ERROR: file too large (" + size + " bytes, limit " + MAX_FILE_BYTES + ").";
                    }
                    String content = Files.readString(file, StandardCharsets.UTF_8);
                    int count = countOccurrences(content, oldString);
                    if (count == 0) {
                        return "ERROR: old_string not found in " + relative + ".";
                    }
                    if (count > 1 && !replaceAll) {
                        return "ERROR: old_string is not unique (" + count + " matches) — add more "
                                + "context or pass replace_all=true.";
                    }
                    String updated;
                    if (replaceAll) {
                        updated = content.replace(oldString, newString);
                    } else {
                        int at = content.indexOf(oldString);
                        updated = content.substring(0, at) + newString
                                + content.substring(at + oldString.length());
                    }
                    Files.writeString(file, updated, StandardCharsets.UTF_8);
                    int replacements = replaceAll ? count : 1;
                    return "Edited: " + relative + " (" + replacements + " replacement"
                            + (replacements == 1 ? "" : "s") + ")";
                } catch (IOException | RuntimeException error) {
                    return "ERROR: " + error.getMessage(); // never throw out of a tool
                }
            }
        };
    }

    /**
     * Counts non-overlapping occurrences of needle in haystack.
     *
     * @param haystack the file content being searched
     * @param needle   the exact string to count — never a regex
     * @return the match count; 0 when absent
     */
    private static int countOccurrences(String haystack, String needle) {
        int count = 0;
        int from = 0;
        int at;
        while ((at = haystack.indexOf(needle, from)) >= 0) {
            count++;
            from = at + needle.length();
        }
        return count;
    }

    // ---- glob (real tool: find files by pattern, read-only) ----------------

    /** Builds {@code glob}: pattern-based file search under the sandbox — read-only, permission-free. */
    private static Tool glob() {
        return new Tool() {
            /** Wire name: {@code glob}. */
            public String name() { return "glob"; }
            /** The model-facing one-liner, with a pattern example. */
            public String description() {
                return "Finds files by glob pattern (e.g. **/*.java) under a directory "
                        + "relative to the working directory. Read-only.";
            }
            /** Required {@code pattern}; optional {@code path} scoping the walk. */
            public JsonNode inputSchema() {
                ObjectNode schema = JSON.createObjectNode();
                schema.put("type", "object");
                ObjectNode properties = JSON.createObjectNode();
                properties.set("pattern", JSON.createObjectNode().put("type", "string"));
                properties.set("path", JSON.createObjectNode().put("type", "string"));
                schema.set("properties", properties);
                schema.set("required", JSON.createArrayNode().add("pattern"));
                return schema;
            }
            /** Read-only search — no gate. */
            public boolean needsPermission() { return false; }

            /** Walks the pruned tree under the optional path and returns the capped, sorted relative matches. */
            public String execute(JsonNode input, ToolContext context) {
                try {
                    String pattern = input.path("pattern").asText();
                    if (pattern.isBlank()) {
                        return "ERROR: pattern must be a non-empty string.";
                    }
                    Path root = resolveInside(context.cwd(), input.path("path").asText("."));
                    PathMatcher matcher = root.getFileSystem().getPathMatcher("glob:" + pattern);
                    List<String> matches = walkMatches(root, matcher, MAX_GLOB_RESULTS);
                    return matches.isEmpty() ? "(no matches)" : String.join("\n", matches);
                } catch (IOException | RuntimeException error) {
                    return "ERROR: " + error.getMessage();
                }
            }
        };
    }

    /**
     * The one pruned tree walk behind glob and grep: ignored subtrees are never
     * ENTERED (Files.walk descended them and paid a stat per entry before the
     * filter dropped them — a large node_modules made the read-only tools crawl),
     * the root's real path resolves once instead of per entry, and only files
     * that survive the cheap filters pay the symlink-escape syscalls. Returns
     * relativized matches, string-sorted, capped at {@code limit}.
     *
     * @param root    the directory the walk starts from — must exist
     * @param matcher glob filter on the relativized path, or null to accept every file
     * @param limit   hard cap on the number of returned matches
     */
    private static List<String> walkMatches(Path root, PathMatcher matcher, long limit)
            throws IOException {
        if (!Files.isDirectory(root)) {
            throw new IOException("no such directory: " + root);
        }
        Path realRoot = root.toRealPath();
        List<String> matches = new ArrayList<>();
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            /** Prunes ignored directories — the subtree is never entered. */
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (!dir.equals(root) && IGNORED_DIRS.contains(dir.getFileName().toString())) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            /** Applies the cheap filters first, the symlink-escape check last, then records the relative match. */
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                if (Files.isDirectory(file)) {
                    return FileVisitResult.CONTINUE; // a symlinked dir is not a file hit
                }
                if (matcher != null && !matcher.matches(root.relativize(file))) {
                    return FileVisitResult.CONTINUE;
                }
                if (!isInside(realRoot, file)) {
                    return FileVisitResult.CONTINUE;
                }
                matches.add(root.relativize(file).toString());
                return FileVisitResult.CONTINUE;
            }

            /** Skips unreadable entries and keeps walking. */
            @Override
            public FileVisitResult visitFileFailed(Path file, IOException unreadable) {
                return FileVisitResult.CONTINUE; // an unreadable entry never fails the search
            }
        });
        return matches.stream().sorted().limit(limit).toList();
    }

    /** True if the resolved real path stays inside the pre-resolved real root —
     *  the symlink-escape guard for tree walks.
     *
     *  @param realRoot the walk root, already toRealPath()-resolved
     *  @param path     the candidate file as the walk encountered it
     *  @return false for escapes AND for paths that fail to resolve — deny by default */
    private static boolean isInside(Path realRoot, Path path) {
        try {
            return path.toRealPath().startsWith(realRoot);
        } catch (IOException unresolved) {
            return false;
        }
    }

    // ---- grep (real tool: search file contents by regex, read-only) --------

    /** Builds {@code grep}: regex search through file contents, path:line:text hits — read-only, permission-free. */
    private static Tool grep() {
        return new Tool() {
            /** Wire name: {@code grep}. */
            public String name() { return "grep"; }
            /** The model-facing one-liner — names the hit format. */
            public String description() {
                return "Searches file contents by regular expression under a directory "
                        + "relative to the working directory, returning path:line:text hits. Read-only.";
            }
            /** Required {@code pattern}; optional {@code path} and {@code glob} filename filter. */
            public JsonNode inputSchema() {
                ObjectNode schema = JSON.createObjectNode();
                schema.put("type", "object");
                ObjectNode properties = JSON.createObjectNode();
                properties.set("pattern", JSON.createObjectNode().put("type", "string"));
                properties.set("path", JSON.createObjectNode().put("type", "string"));
                properties.set("glob", JSON.createObjectNode().put("type", "string"));
                schema.set("properties", properties);
                schema.set("required", JSON.createArrayNode().add("pattern"));
                return schema;
            }
            /** Read-only search — no gate. */
            public boolean needsPermission() { return false; }

            /** Regex-scans every file the pruned walk yields, emitting path:line:text hits up to the shared output cap. */
            public String execute(JsonNode input, ToolContext context) {
                try {
                    String patternText = input.path("pattern").asText();
                    if (patternText.isBlank()) {
                        return "ERROR: pattern must be a non-empty string.";
                    }
                    Pattern pattern;
                    try {
                        pattern = Pattern.compile(patternText);
                    } catch (PatternSyntaxException invalid) {
                        return "ERROR: invalid regex: " + invalid.getMessage();
                    }
                    Path root = resolveInside(context.cwd(), input.path("path").asText("."));
                    String glob = input.path("glob").asText("");
                    PathMatcher matcher = glob.isBlank() ? null
                            : root.getFileSystem().getPathMatcher("glob:" + glob);
                    StringBuilder out = new StringBuilder();
                    for (String rel : walkMatches(root, matcher, Long.MAX_VALUE)) {
                        Path file = root.resolve(rel);
                        if (Files.size(file) > MAX_FILE_BYTES) {
                            continue;
                        }
                        List<String> lines;
                        try {
                            lines = Files.readAllLines(file, StandardCharsets.UTF_8);
                        } catch (IOException unreadable) {
                            continue; // binary / non-UTF8 file — skip it
                        }
                        for (int i = 0; i < lines.size(); i++) {
                            if (pattern.matcher(lines.get(i)).find()) {
                                out.append(rel).append(':').append(i + 1).append(':')
                                        .append(lines.get(i)).append('\n');
                                if (out.length() > MAX_OUTPUT_CHARS) {
                                    return ToolOutput.clip(out.toString(), MAX_OUTPUT_CHARS);
                                }
                            }
                        }
                    }
                    return out.isEmpty() ? "(no matches)" : out.toString();
                } catch (IOException | RuntimeException error) {
                    return "ERROR: " + error.getMessage();
                }
            }
        };
    }
}
