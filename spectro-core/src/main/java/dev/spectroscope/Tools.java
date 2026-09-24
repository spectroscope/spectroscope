package dev.spectroscope;

import dev.spectroscope.core.tools.StandardTools;
import dev.spectroscope.core.tools.Tool;

import java.util.List;

/**
 * Tool factories that read as plain names — the frozen facade's tool
 * vocabulary: {@code .tools(Tools.readFile(), Tools.runCommand())}. Every
 * factory hands out one tool from the standard belt; the names are the wire
 * names of the event protocol.
 */
public final class Tools {

    private Tools() {}

    /** @return read_file — bounded file reads inside the workspace */
    public static Tool readFile() {
        return byName("read_file");
    }

    /** @return write_file — create or overwrite a workspace file */
    public static Tool writeFile() {
        return byName("write_file");
    }

    /** @return edit_file — exact-match replacement inside a workspace file */
    public static Tool editFile() {
        return byName("edit_file");
    }

    /** @return list_dir — a workspace directory listing */
    public static Tool listDir() {
        return byName("list_dir");
    }

    /** @return glob — filename patterns over the workspace */
    public static Tool glob() {
        return byName("glob");
    }

    /** @return grep — content search over the workspace */
    public static Tool grep() {
        return byName("grep");
    }

    /** @return run_command — a shell command in the workspace (permission-gated) */
    public static Tool runCommand() {
        return byName("run_command");
    }

    /** @return view_image — shows the model an image from the workspace */
    public static Tool viewImage() {
        return byName("view_image");
    }

    /** @return view_file — shows the model a document from the workspace */
    public static Tool viewFile() {
        return byName("view_file");
    }

    /** @return the full standard belt, in registration order */
    public static List<Tool> all() {
        // settings-reach: commandTimeoutSeconds
        //     | embedded library | this belt is assembled by a JVM program that
        //     took spectroscope as a dependency, so its numbers come from the
        //     code that declares them and not from an operator's settings file
        //     on whatever machine that program happens to run on. A library that
        //     read one would change an embedder's behaviour because somebody
        //     else edited a file they have never seen. The facade's surface is
        //     frozen (konzept/SPECTRO-API.md), so there is no second arity here
        //     to hand a budget to either; an embedder that wants its own builds
        //     the belt with StandardTools.all(long) directly.
        return StandardTools.all();
    }

    private static Tool byName(String name) {
        // settings-reach: commandTimeoutSeconds
        //     | embedded library | the same belt, taken one tool at a time, and
        //     the path behind Tools.runCommand() itself. Same facade, same
        //     absence of a settings file it could honestly read, same frozen
        //     surface.
        return StandardTools.all().stream()
                .filter(tool -> name.equals(tool.name()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("standard tool missing: " + name));
    }
}
