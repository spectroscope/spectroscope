package dev.spectroscope.server.spectrolyzr;

import dev.spectroscope.server.starter.FolderWriter;

import java.io.IOException;
import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Renders every archetype of one language for the CI job that builds them, with
 * no Spring context and no network.
 *
 * <p>Per archetype two folders appear under the output folder: {@code
 * <archetype>-bare} holds {@code project/} rendered without add-ons, and {@code
 * <archetype>-full} holds {@code project/} and {@code playbook/} rendered with
 * every add-on. Both use the name {@code ledger-api}. Next to {@code project/}
 * each folder gets {@code check-command.txt} with the command that checks the
 * project: the language's test command for a bare folder, its gate command for
 * a full one. One line per folder, {@code <folder><TAB><check command>}, goes to
 * the output stream. The writes go through {@link FolderWriter}, so an existing
 * folder from an earlier run is refused and kept.
 *
 * <p>Usage: {@code RenderAll --out <dir> --language <id>}.
 */
public final class RenderAll {

    static final String SAMPLE_NAME = "ledger-api";
    static final String CHECK_FILE = "check-command.txt";

    private RenderAll() {
    }

    /**
     * Command line entry point; exits with the code {@link #run} returns.
     *
     * @param args {@code --out <dir> --language <id>}
     */
    public static void main(String[] args) {
        int exit = run(args, System.out, System.err);
        if (exit != 0) {
            System.exit(exit);
        }
    }

    /**
     * Renders and writes, and reports on the given streams.
     *
     * @param args {@code --out <dir> --language <id>}
     * @param out  receives one line per written folder
     * @param err  receives usage and refusals
     * @return 0 when every folder was written, 1 on a refusal or a failure, 2 on bad arguments
     */
    public static int run(String[] args, PrintStream out, PrintStream err) {
        String outDir = null;
        String language = null;
        for (int i = 0; i + 1 < args.length; i += 2) {
            switch (args[i]) {
                case "--out" -> outDir = args[i + 1];
                case "--language" -> language = args[i + 1];
                default -> {
                    err.println("Unknown argument: " + args[i]);
                    return usage(err);
                }
            }
        }
        if (outDir == null || language == null || args.length % 2 != 0) {
            return usage(err);
        }

        ManifestReader.Read read = ManifestReader.read(SpectrolyzrController.RESOURCE_ROOT);
        if (read.manifest() == null || !read.problems().isEmpty()) {
            err.println("The Spectrolyzr manifest is broken: " + read.problems());
            return 1;
        }
        Manifest manifest = read.manifest();
        String chosenLanguage = language;
        Manifest.Language lang = manifest.languages().stream().filter(l -> l.id().equals(chosenLanguage))
                .findFirst().orElse(null);
        if (lang == null) {
            err.println("Unknown language: " + language + ". Known: "
                    + manifest.languages().stream().map(Manifest.Language::id).toList());
            return 2;
        }

        Path root = Path.of(outDir).toAbsolutePath().normalize();
        try {
            Files.createDirectories(root);
        } catch (IOException failure) {
            err.println("Cannot create " + root + ": " + failure.getMessage());
            return 1;
        }
        List<String> allAddons = manifest.addons().stream().map(Manifest.Addon::id).toList();
        for (Manifest.Archetype archetype : manifest.archetypes()) {
            for (boolean full : new boolean[] {false, true}) {
                String folder = archetype.id() + (full ? "-full" : "-bare");
                Choices choices = new Choices(archetype.id(), language, full ? allAddons : List.of(), SAMPLE_NAME);
                String check = lang.commands().get(full ? "gate" : "test");
                int exit = write(root.resolve(folder), folder, Spectrolyzr.render(manifest, choices), check, err);
                if (exit != 0) {
                    return exit;
                }
                out.println(folder + "\t" + check);
            }
        }
        return 0;
    }

    private static int usage(PrintStream err) {
        err.println("Usage: RenderAll --out <dir> --language <id>");
        return 2;
    }

    private static int write(Path dir, String folder, List<RenderedFile> files, String check, PrintStream err) {
        Map<String, String> keyed = new LinkedHashMap<>();
        for (RenderedFile file : files) {
            keyed.put(file.root() + "/" + file.path(), file.content());
        }
        keyed.put(CHECK_FILE, check + "\n");
        FolderWriter.Planned planned = FolderWriter.plan(dir, keyed, true);
        if (!(planned instanceof FolderWriter.Ready ready)) {
            err.println("Refused " + folder + ": " + ((FolderWriter.Refused) planned).result());
            return 1;
        }
        FolderWriter.Result result = FolderWriter.write(ready);
        if (!(result instanceof FolderWriter.Written)) {
            err.println("Failed " + folder + ": " + result);
            return 1;
        }
        return 0;
    }
}
