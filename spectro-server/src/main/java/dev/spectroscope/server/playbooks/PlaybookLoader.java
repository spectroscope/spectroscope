package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.graph.Topology;
import dev.spectroscope.core.playbook.Finding;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.PlaybookTopology;
import dev.spectroscope.core.playbook.PlaybookValidator;
import dev.spectroscope.core.skills.SkillLibrary;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * Loads a playbook folder for the playbook module: the playbook, its drawing,
 * the findings of the reader, the validator and the folder checks, and per
 * step whether its skills are installed and what state its model's provider
 * is in.
 *
 * <p>It reads {@code playbook.json} and nothing else; the paths
 * {@code contents} names are only checked to exist inside the folder (spec
 * rule 8). {@code playbook.json} is read only up to {@link #MAX_BYTES}, and a
 * folder of more than {@link #MAX_FILES} files is a finding.
 */
public final class PlaybookLoader {

    /** The largest {@code playbook.json} the loader reads. */
    static final long MAX_BYTES = 1024L * 1024;
    /** The most files a playbook folder may hold, counted to {@link #WALK_DEPTH}. */
    static final int MAX_FILES = 200;
    static final int WALK_DEPTH = 4;

    public record Loaded(Playbook playbook, Topology topology, List<Finding> findings,
                         List<StepResolution> steps, String dir) {}

    public record StepResolution(String id, List<SkillState> skills, ModelState model) {}

    public record SkillState(String name, boolean installed) {}

    public record ModelState(String choice, String provider, String model, String state, String reason) {}

    private PlaybookLoader() {
    }

    public static Loaded load(Path dir, Path workspace, SpectroConfig config) {
        return load(dir, workspace, config, ProviderStates.current());
    }

    static Loaded load(Path dir, Path workspace, SpectroConfig config, ProviderStates providers) {
        Path root;
        try {
            root = dir.toRealPath();
        } catch (IOException missing) {
            return refused(dir.toString(), new Finding("", "not a folder: " + dir));
        }
        Path file = root.resolve(PlaybookFolders.PLAYBOOK_FILE);
        String json;
        try {
            if (!Files.isRegularFile(file)) {
                return refused(root.toString(), new Finding(PlaybookFolders.PLAYBOOK_FILE, "missing"));
            }
            if (Files.size(file) > MAX_BYTES) {
                return refused(root.toString(), new Finding(PlaybookFolders.PLAYBOOK_FILE,
                        "larger than 1 MB; not read"));
            }
            json = Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException unreadable) {
            return refused(root.toString(), new Finding(PlaybookFolders.PLAYBOOK_FILE,
                    "unreadable: " + unreadable.getMessage()));
        }

        PlaybookReader.Read read = PlaybookReader.read(json);
        List<Finding> findings = new ArrayList<>(read.findings());
        Playbook p = read.playbook();
        if (p == null) {
            return new Loaded(null, null, List.copyOf(findings), List.of(), root.toString());
        }
        findings.addAll(PlaybookValidator.validate(p));
        findings.addAll(contentsFindings(root, p.contents()));
        countFiles(root, findings);

        SkillLibrary skills = SkillLibrary.load(SkillLibrary.defaultRoots(workspace));
        List<StepResolution> steps = new ArrayList<>();
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Step s) {
                List<SkillState> states = s.skills().stream()
                        .map(name -> new SkillState(name, skills.find(name).isPresent()))
                        .toList();
                steps.add(new StepResolution(s.id(), states, model(p, s.model(), config, providers)));
            }
        }
        return new Loaded(p, PlaybookTopology.of(p), List.copyOf(findings), List.copyOf(steps), root.toString());
    }

    private static Loaded refused(String dir, Finding finding) {
        return new Loaded(null, null, List.of(finding), List.of(), dir);
    }

    private static ModelState model(Playbook p, String choice, SpectroConfig config, ProviderStates providers) {
        if (choice == null || choice.isBlank()) {
            return new ModelState(choice, null, null, "none", "the step names no model choice");
        }
        Playbook.ModelChoice chosen = p.models().get(choice);
        if (chosen == null || chosen.primary() == null) {
            return new ModelState(choice, null, null, "unknown", "the playbook has no model choice of this name");
        }
        String provider = chosen.primary().provider();
        String model = chosen.primary().model();
        ProviderStates.State state = providers.of(provider, model, config);
        return new ModelState(choice, provider, model, state.state(), state.reason());
    }

    /** Spec rule 8: every {@code contents} path exists under the folder and stays inside it. */
    static List<Finding> contentsFindings(Path root, Playbook.Contents contents) {
        List<Finding> out = new ArrayList<>();
        if (contents == null) {
            return out;
        }
        Map<String, List<String>> lists = new java.util.LinkedHashMap<>();
        lists.put("skills", contents.skills());
        lists.put("agents", contents.agents());
        lists.put("hooks", contents.hooks());
        lists.put("commands", contents.commands());
        lists.put("workflows", contents.workflows());
        for (Map.Entry<String, List<String>> list : lists.entrySet()) {
            List<String> entries = list.getValue() == null ? List.of() : list.getValue();
            for (int i = 0; i < entries.size(); i++) {
                String at = "contents." + list.getKey() + "[" + i + "]";
                String problem = contentsProblem(root, entries.get(i));
                if (problem != null) {
                    out.add(new Finding(at, problem));
                }
            }
        }
        return out;
    }

    private static String contentsProblem(Path root, String entry) {
        if (entry == null || entry.isBlank()) {
            return "an empty path";
        }
        Path relative;
        try {
            relative = Path.of(entry);
        } catch (RuntimeException invalid) {
            return "not a path";
        }
        if (relative.isAbsolute()) {
            return "an absolute path; contents paths are relative to the playbook folder";
        }
        Path target = root.resolve(relative).normalize();
        if (!target.startsWith(root)) {
            return "leaves the playbook folder";
        }
        if (!Files.exists(target)) {
            return "does not exist in the playbook folder";
        }
        try {
            if (!target.toRealPath().startsWith(root)) {
                return "a link that leaves the playbook folder";
            }
        } catch (IOException unreadable) {
            return "unreadable: " + unreadable.getMessage();
        }
        return null;
    }

    private static void countFiles(Path root, List<Finding> findings) {
        long files;
        try (Stream<Path> walk = Files.walk(root, WALK_DEPTH)) {
            files = walk.filter(Files::isRegularFile).limit(MAX_FILES + 1L).count();
        } catch (IOException | java.io.UncheckedIOException unreadable) {
            findings.add(new Finding("contents", "the folder could not be counted: " + unreadable.getMessage()));
            return;
        }
        if (files > MAX_FILES) {
            findings.add(new Finding("contents", "the folder holds more than " + MAX_FILES + " files"));
        }
    }
}
