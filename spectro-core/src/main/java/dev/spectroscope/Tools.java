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
        return StandardTools.all();
    }

    private static Tool byName(String name) {
        return StandardTools.all().stream()
                .filter(tool -> name.equals(tool.name()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("standard tool missing: " + name));
    }
}
