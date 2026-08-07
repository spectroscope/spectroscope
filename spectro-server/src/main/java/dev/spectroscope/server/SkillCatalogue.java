package dev.spectroscope.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.skills.Skill;
import dev.spectroscope.core.skills.SkillLibrary;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryNotEmptyException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Stream;

/**
 * The shelf a marketplace install copies from (card 182): four vendored skill
 * collections that ride inside the artifact as {@code skills-catalogue/…}
 * classpath resources, and the copy that puts one of them into the user's
 * skills root.
 *
 * <p>Two rules carry the whole design. The first is that a skill is <em>the
 * directory that contains a SKILL.md</em>, found by enumeration — the catalogue
 * nests two different ways ({@code <pack>/skills/<skill>} and
 * {@code <pack>/skills/<category>/<skill>}) and neither depth ever enters the
 * code as a number. The second is that nothing a caller says reaches the
 * filesystem: an install names an <em>id</em> that must match an enumerated
 * entry by string equality, and the destination folder is the leaf name that
 * entry already carries.</p>
 *
 * <p>Nothing here executes a file, restores an execute bit, or opens a path off
 * the wire. Files are written byte for byte out of {@link Resource} streams, so
 * the output cannot contain a symlink either.</p>
 */
public class SkillCatalogue {

    private static final Logger log = LoggerFactory.getLogger(SkillCatalogue.class);

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The classpath directory the whole catalogue lives under. */
    static final String CATALOGUE = "skills-catalogue";

    /** The licence the pack ships, and the record of where the pack came from. */
    private static final String LICENCE_FILE = "LICENSE";
    private static final String PROVENANCE_FILE = "PROVENANCE.json";

    /** What this install writes beside the copy, so a folder can say where it is from. */
    private static final String INSTALL_RECORD = "spectro-install.json";

    /**
     * Ceilings, not policy: the biggest catalogue skill today is 98 files and
     * 5.8 MB, so both leave room for a fatter one and still refuse a runaway.
     */
    static final int MAX_FILES = 400;
    static final long MAX_BYTES = 24L * 1024 * 1024;

    /** Where a half-built skill waits — a SIBLING of the skills root, never inside it. */
    static final String STAGING_DIR = ".skill-install";

    /**
     * One catalogue skill, as the UI lists it and the installer copies it.
     *
     * @param id          the opaque catalogue id, {@code <pack>/<name>}
     * @param name        the leaf folder that holds SKILL.md — also the destination folder
     * @param pack        the collection this skill belongs to
     * @param dir         the catalogue-relative directory, e.g. {@code superpowers/skills/brainstorming}
     * @param description the frontmatter description, as the model would read it
     * @param licence     the pack's licence identifier
     * @param repo        the upstream repository the pack was vendored from
     * @param commit      the upstream commit that was vendored
     * @param files       how many files the leaf directory holds
     * @param bytes       how large those files are together
     */
    public record Entry(String id, String name, String pack, String dir, String description,
            String licence, String repo, String commit, int files, long bytes) {
    }

    /** How an install ended. Every value but {@link #INSTALLED} means nothing was written. */
    public enum Status {
        /** The skill is on disk and complete. */
        INSTALLED,
        /** The dry run exceeded a ceiling. */
        TOO_LARGE,
        /** The destination folder appeared between the check and the move. */
        TAKEN,
        /** An I/O failure, or a licence that could not be read. */
        FAILED
    }

    /**
     * The outcome of one install.
     *
     * @param status  how it ended
     * @param message a sentence for the caller, empty on success
     * @param facts   what landed (or, on a refusal, the numbers behind it)
     */
    public record InstallResult(Status status, String message, Map<String, Object> facts) {
    }

    /** One catalogue file with its measured size — kept out of {@link Entry}, which is API. */
    private record FileRef(String rel, Resource resource, long bytes) {
    }

    /** The enumerated catalogue: the rows, and the files behind each row. */
    private record Shelf(List<Entry> entries, Map<String, List<FileRef>> filesByDir) {
    }

    /**
     * Built once per process. The catalogue is inside the artifact, so it cannot
     * change under a running server; {@code installed} is the only part of a
     * listing that varies, and the controller recomputes that per request.
     */
    private static volatile Shelf shelf;

    private final int maxFiles;
    private final long maxBytes;

    /** The shipped ceilings. */
    public SkillCatalogue() {
        this(MAX_FILES, MAX_BYTES);
    }

    SkillCatalogue(int maxFiles, long maxBytes) {
        this.maxFiles = maxFiles;
        this.maxBytes = maxBytes;
    }

    // ---- the index -----------------------------------------------------------------------

    /**
     * Every skill on the shelf, sorted by id. A build without the catalogue
     * resource yields an empty list — the UI says so rather than pretending.
     *
     * @return the catalogue rows, never null
     */
    public static List<Entry> index() {
        return shelf().entries();
    }

    /**
     * Looks one entry up by its opaque id. String equality, never a path
     * resolution: an id that is not on the shelf is unknown, whatever it spells.
     *
     * @param id the catalogue id from the request body
     * @return the entry, or empty when nothing matches exactly
     */
    public static Optional<Entry> find(String id) {
        return index().stream().filter(entry -> entry.id().equals(id)).findFirst();
    }

    private static Shelf shelf() {
        Shelf known = shelf;
        if (known == null) {
            synchronized (SkillCatalogue.class) {
                known = shelf;
                if (known == null) {
                    known = enumerate();
                    shelf = known;
                }
            }
        }
        return known;
    }

    /**
     * The part of a resource URL that follows an anchor, taken by
     * {@code lastIndexOf} of the literal.
     *
     * <p>Counting {@code /} segments — the trick {@code BundledSkills} can
     * afford because it only ever wants the one folder before the file — cannot
     * work here: the catalogue nests two different depths, and a Spring Boot fat
     * jar spells its resources {@code jar:nested:/app.jar/!BOOT-INF/classes/!/…},
     * so the number of separators and of {@code !} marks ahead of the catalogue
     * is not knowable. The literal directory name is knowable, and it is unique:
     * no path below the catalogue root carries a segment of that name.</p>
     *
     * @param url    the resource URL as a string
     * @param anchor the literal to anchor on, trailing slash included
     * @return what follows the last occurrence of the anchor, or null when it is absent
     */
    static String relativeAfter(String url, String anchor) {
        int at = url.lastIndexOf(anchor);
        return at < 0 ? null : url.substring(at + anchor.length());
    }

    private static Shelf enumerate() {
        Map<String, List<FileRef>> filesByDir = new LinkedHashMap<>();
        List<Entry> entries = new ArrayList<>();
        try {
            List<FileRef> all = readCatalogue();
            Set<String> skillDirs = new LinkedHashSet<>();
            for (FileRef file : all) {
                if (file.rel().endsWith("/SKILL.md")) {
                    skillDirs.add(file.rel().substring(0, file.rel().length() - "/SKILL.md".length()));
                }
            }
            for (FileRef file : all) {
                // Longest match, so a skill nested inside another one would still
                // land in the nearer folder rather than being copied twice.
                String owner = null;
                for (String dir : skillDirs) {
                    if (file.rel().startsWith(dir + "/") && (owner == null || dir.length() > owner.length())) {
                        owner = dir;
                    }
                }
                if (owner != null) {
                    filesByDir.computeIfAbsent(owner, key -> new ArrayList<>()).add(file);
                }
            }
            Map<String, JsonNode> provenanceByPack = new LinkedHashMap<>();
            for (String dir : skillDirs) {
                Entry entry = describe(dir, filesByDir.getOrDefault(dir, List.of()), provenanceByPack);
                if (entry != null) {
                    entries.add(entry);
                }
            }
            entries.sort(Comparator.comparing(Entry::id));
        } catch (IOException unreadable) {
            log.warn("skill catalogue unreadable, the shelf stays empty ({})", unreadable.toString());
        }
        return new Shelf(List.copyOf(entries), Map.copyOf(filesByDir));
    }

    /** Every readable catalogue file, keyed by its path below the catalogue root. */
    private static List<FileRef> readCatalogue() throws IOException {
        List<FileRef> files = new ArrayList<>();
        Resource[] found = new PathMatchingResourcePatternResolver()
                .getResources("classpath*:" + CATALOGUE + "/**");
        for (Resource resource : found) {
            String url = String.valueOf(resource.getURL());
            if (url.endsWith("/") || !resource.isReadable()) {
                continue; // a directory comes back as a non-readable resource
            }
            String rel = relativeAfter(url, CATALOGUE + "/");
            if (rel == null || rel.isEmpty()) {
                log.warn("skipping catalogue resource without the {} anchor: {}", CATALOGUE, url);
                continue; // never guessed, only skipped
            }
            files.add(new FileRef(rel, resource, sizeOf(resource)));
        }
        return files;
    }

    private static long sizeOf(Resource resource) {
        try {
            return resource.contentLength();
        } catch (IOException unknown) {
            return 0L; // an unmeasurable entry must not make the ceiling refuse everything
        }
    }

    /** Builds one catalogue row, or null when the pack has no provenance to name. */
    private static Entry describe(String dir, List<FileRef> files, Map<String, JsonNode> provenanceByPack) {
        String[] segments = dir.split("/");
        String pack = segments[0];
        String name = segments[segments.length - 1];
        JsonNode provenance = provenanceByPack.computeIfAbsent(pack, SkillCatalogue::readProvenance);
        if (provenance == null) {
            log.warn("skipping catalogue pack {} — no readable {}", pack, PROVENANCE_FILE);
            return null;
        }
        String description = files.stream()
                .filter(file -> file.rel().equals(dir + "/SKILL.md"))
                .findFirst()
                .map(file -> descriptionOf(file, name))
                .orElse("");
        long bytes = files.stream().mapToLong(FileRef::bytes).sum();
        return new Entry(pack + "/" + name, name, pack, dir, description,
                provenance.path("licence").asText(""),
                provenance.path("repo").asText(""),
                provenance.path("commit").asText(""),
                files.size(), bytes);
    }

    private static String descriptionOf(FileRef file, String name) {
        try (InputStream in = file.resource().getInputStream()) {
            String raw = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            Skill parsed = SkillLibrary.parse(raw, name, Path.of(CATALOGUE, file.rel()));
            return parsed.description();
        } catch (IOException | RuntimeException broken) {
            log.warn("catalogue skill {} has an unreadable SKILL.md ({})", name, broken.toString());
            return "";
        }
    }

    private static JsonNode readProvenance(String pack) {
        Resource resource = new PathMatchingResourcePatternResolver()
                .getResource("classpath:" + CATALOGUE + "/" + pack + "/" + PROVENANCE_FILE);
        if (!resource.isReadable()) {
            return null;
        }
        try (InputStream in = resource.getInputStream()) {
            return JSON.readTree(in);
        } catch (IOException unreadable) {
            return null;
        }
    }

    // ---- the install ---------------------------------------------------------------------

    /**
     * Copies one catalogue skill into place: the whole leaf directory flat, the
     * pack's LICENSE and PROVENANCE.json beside it, and a record of where it
     * came from. Everything is built in a staging directory and promoted with
     * one atomic move, so any failure leaves the skills root exactly as it was.
     *
     * <p>The staging root is a PARAMETER rather than something derived from the
     * target, and it has one requirement: it must sit outside the skills root.
     * A half-built folder inside the root already carries a SKILL.md, so a
     * concurrent load would pick it up — and since the destination is now nested
     * one level ({@code <root>/<pack>/<skill>}), deriving the staging directory
     * from the target's parent would have put it in exactly the wrong place.</p>
     *
     * @param entry       the catalogue row to copy, already looked up by id
     * @param target      the destination folder, derived by the caller from the entry
     * @param stagingRoot where half-built copies wait — must be outside the skills root
     * @return what happened; only {@link Status#INSTALLED} means anything was written
     */
    public InstallResult install(Entry entry, Path target, Path stagingRoot) {
        List<FileRef> files = shelf().filesByDir().getOrDefault(entry.dir(), List.of());
        Resource licence = packFile(entry.pack(), LICENCE_FILE);
        Resource provenance = packFile(entry.pack(), PROVENANCE_FILE);
        if (licence == null || provenance == null) {
            // Card 182: refuse an install whose licence the installer cannot read,
            // and say why. MIT is satisfied by the LICENSE travelling with the
            // copy; without it there is no honest copy to make.
            return failure("The pack's LICENSE could not be read — refusing to install an unlicensed copy.");
        }

        int count = files.size() + 3; // the two pack files and the install record
        long bytes = files.stream().mapToLong(FileRef::bytes).sum() + sizeOf(licence) + sizeOf(provenance);
        if (count > maxFiles || bytes > maxBytes) {
            return new InstallResult(Status.TOO_LARGE,
                    "Too large to install: " + count + " files, " + bytes + " bytes.",
                    Map.of("files", count, "bytes", bytes));
        }

        Path staging = stagingRoot.resolve(entry.name() + "-" + System.nanoTime());
        try {
            Files.createDirectories(staging);
            for (FileRef file : files) {
                String rel = relativeAfter(file.rel(), entry.dir() + "/");
                if (rel == null || rel.isEmpty()) {
                    return failure("A catalogue file sits outside its own skill: " + file.rel());
                }
                Path destination = staging.resolve(rel).normalize();
                if (!destination.startsWith(staging)) {
                    return failure("A catalogue file would land outside the skill: " + rel);
                }
                Files.createDirectories(destination.getParent());
                copy(file.resource(), destination);
            }
            copy(licence, free(staging, LICENCE_FILE, entry.pack()));
            copy(provenance, free(staging, PROVENANCE_FILE, entry.pack()));
            Files.writeString(staging.resolve(INSTALL_RECORD), installRecord(entry), StandardCharsets.UTF_8);

            Files.createDirectories(target.getParent());
            Files.move(staging, target, StandardCopyOption.ATOMIC_MOVE);
            return new InstallResult(Status.INSTALLED, "", Map.of(
                    "name", entry.name(),
                    "pack", entry.pack(),
                    "files", count,
                    "bytes", bytes,
                    "licence", entry.licence(),
                    "commit", entry.commit()));
        } catch (FileAlreadyExistsException | DirectoryNotEmptyException taken) {
            // The race behind the caller's pre-check: somebody created the folder
            // between the look and the move. The pre-check's answer still holds.
            return new InstallResult(Status.TAKEN, "That name is taken — delete it first.",
                    Map.of("name", entry.name()));
        } catch (IOException | RuntimeException failure) {
            return failure(String.valueOf(failure.getMessage()));
        } finally {
            deleteTree(staging);
            deleteIfEmpty(stagingRoot);
        }
    }

    /**
     * The pack file to copy — the seam the licence-refusal test replaces.
     *
     * @param pack     the collection name
     * @param fileName the file beside the collection, LICENSE or PROVENANCE.json
     * @return the resource, or null when it is missing or unreadable
     */
    Resource packFile(String pack, String fileName) {
        Resource resource = new PathMatchingResourcePatternResolver()
                .getResource("classpath:" + CATALOGUE + "/" + pack + "/" + fileName);
        return resource.isReadable() ? resource : null;
    }

    /**
     * Writes one catalogue file to disk, byte for byte. No permission is copied
     * with it, which is how a skill's shell script arrives readable and not
     * runnable — the seam the failed-copy test replaces.
     *
     * @param source      the catalogue resource
     * @param destination where it lands inside the staging directory
     * @throws IOException when the read or the write fails
     */
    void copy(Resource source, Path destination) throws IOException {
        try (InputStream in = source.getInputStream()) {
            Files.copy(in, destination, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /**
     * A name for the pack file that the skill's own files have not already
     * taken. No catalogue skill ships a LICENSE or PROVENANCE.json of its own
     * today, but if one ever does, the pack's licence still has to travel —
     * overwriting it would drop exactly the file MIT requires to be there.
     */
    private static Path free(Path staging, String fileName, String pack) {
        Path plain = staging.resolve(fileName);
        if (!Files.exists(plain)) {
            return plain;
        }
        int dot = fileName.lastIndexOf('.');
        return staging.resolve(dot < 0
                ? fileName + "." + pack
                : fileName.substring(0, dot) + "." + pack + fileName.substring(dot));
    }

    private static String installRecord(Entry entry) throws IOException {
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("pack", entry.pack());
        record.put("skill", entry.name());
        record.put("repo", entry.repo());
        record.put("commit", entry.commit());
        record.put("licence", entry.licence());
        record.put("source", "bundled catalogue");
        record.put("installedOn", LocalDate.now().toString());
        return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(record) + "\n";
    }

    private static InstallResult failure(String message) {
        return new InstallResult(Status.FAILED, message, Map.of());
    }

    private static void deleteTree(Path root) {
        if (!Files.exists(root)) {
            return;
        }
        try (Stream<Path> walk = Files.walk(root)) {
            for (Path path : walk.sorted(Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        } catch (IOException stubborn) {
            log.warn("could not clear the staging directory {} ({})", root, stubborn.toString());
        }
    }

    private static void deleteIfEmpty(Path dir) {
        try (Stream<Path> entries = Files.list(dir)) {
            if (entries.findAny().isEmpty()) {
                Files.deleteIfExists(dir);
            }
        } catch (IOException absentOrBusy) {
            // an absent or non-empty staging root is fine — another install may own it
        }
    }
}
