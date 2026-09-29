package dev.spectroscope.server.transcripts;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Shows a directory to the person sitting at the machine.
 *
 * <p>One place, on purpose. This is the only code in the server that hands a
 * path to another program, so the rules that make it safe are stated once and
 * enforced once rather than repeated at every call site:</p>
 *
 * <ul>
 *   <li><b>No shell.</b> {@link ProcessBuilder} with an argument list, never a
 *       command string. A folder called {@code ; rm -rf ~} is a folder name and
 *       stays one — there is no interpreter to read it as anything else.</li>
 *   <li><b>Directories only, resolved first.</b> The caller's path is realised
 *       and stat'd here as well, not only upstream, because "the last check is
 *       the one that runs beside the effect" is exactly the lesson the
 *       {@code /%61pi/} bypass taught in v0.6.1.</li>
 *   <li><b>The opener is a constant.</b> The program name is chosen from the OS
 *       and never from anything a caller sends.</li>
 * </ul>
 *
 * <p>Fire and forget: the process is started and not waited on. A file manager
 * runs for as long as the person keeps it open, and a request that waited for
 * it would hold a server thread until they closed Finder.</p>
 */
public final class FolderOpener {

    /** The result, so the endpoint can answer honestly rather than always 200. */
    public enum Result {
        /** The file manager was started. */
        OPENED,
        /** There is no such directory. */
        MISSING,
        /** This platform has no opener we know, or starting it failed. */
        UNSUPPORTED
    }

    /** Starts a program from an argument list. Tests pass one that records the argv. */
    @FunctionalInterface
    public interface Launcher {
        /**
         * Starts the program and returns without waiting for it.
         *
         * @param argv the program and its arguments, never a shell string
         * @throws IOException when the program cannot be started
         */
        void start(List<String> argv) throws IOException;
    }

    /** The production launcher: a real process, output discarded, not waited on. */
    public static final Launcher PROCESS = argv -> new ProcessBuilder(argv)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .redirectError(ProcessBuilder.Redirect.DISCARD)
            .start();

    private FolderOpener() {}

    /**
     * The program that shows a folder on this OS, or null when there is none.
     *
     * @return the argv prefix, or null
     */
    private static List<String> opener() {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        if (os.contains("mac")) {
            return List.of("/usr/bin/open");
        }
        if (os.contains("win")) {
            return List.of("explorer.exe");
        }
        // Every desktop Linux ships it; a headless box has no file manager to
        // open anything in, and answers UNSUPPORTED rather than pretending.
        return List.of("xdg-open");
    }

    /**
     * Opens a directory in the machine's file manager.
     *
     * @param folder the directory to show; may be null
     * @return what happened
     */
    static Result open(Path folder) {
        return open(folder, opener(), PROCESS);
    }

    /**
     * Hands a directory to a program as its last argument, after realising it
     * and checking it is a directory.
     *
     * @param folder the directory; may be null
     * @param program the argv prefix, a constant chosen by the caller, or null
     *        when this platform has none
     * @param launcher starts the process
     * @return what happened
     */
    public static Result open(Path folder, List<String> program, Launcher launcher) {
        if (folder == null) {
            return Result.MISSING;
        }
        Path real;
        try {
            real = folder.toRealPath();
        } catch (IOException gone) {
            return Result.MISSING;
        }
        if (!Files.isDirectory(real)) {
            return Result.MISSING;
        }
        if (program == null || program.isEmpty()) {
            return Result.UNSUPPORTED;
        }
        List<String> argv = new ArrayList<>(program);
        argv.add(real.toString());
        try {
            launcher.start(List.copyOf(argv));
            return Result.OPENED;
        } catch (IOException | SecurityException cannot) {
            // No opener installed, or the sandbox forbids spawning. Neither is
            // an error the reader can act on beyond "it did not open".
            return Result.UNSUPPORTED;
        }
    }
}
