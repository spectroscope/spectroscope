package dev.spectroscope.core.launch;

import com.fasterxml.jackson.core.util.DefaultIndenter;
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import dev.spectroscope.core.config.SpectroDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Authoring a launch file — card 352, the operator's half.
 *
 * <h2>The destination is not a parameter</h2>
 *
 * <p>{@link #write(Path, List)} takes a project root and puts the file at
 * {@link LaunchFile#OURS}. There is no overload that takes a path, because the
 * owner's rule — "wenn wir eine launch datei schreiben dann in .spectro" — is
 * worth more as a shape the caller cannot get wrong than as a sentence everyone
 * has to remember. Nothing here can produce a {@code .claude} path, and
 * {@code ClaudeFolderStaysTheirsDriftTest} keeps that true for the whole tree
 * rather than only for this class.
 *
 * <h2>⛔ Who may call it, and what was NOT decided</h2>
 *
 * <p>Card 352 criterion 1 asks whether an AGENT may write a launch entry, and
 * <b>the owner has not answered</b>. So this ships with no tool wrapper: the
 * five verbs in {@link LaunchTools} do not reach it, {@code tool-tiers.json}
 * gains no entry, and a model has no way to call it. The reason is in
 * {@link LaunchTools}' own words — {@code runtimeExecutable} is a free string,
 * so a launch file is a remote-code-execution primitive wearing a config file's
 * clothes, and a tool that authors one hands the model on the next play whatever
 * it wrote on this one. An operator writing the same file through his own UI is
 * a different act: he can already open an editor, and the product doing it for
 * him changes convenience rather than authority.
 *
 * <h2>What is validated, and the guard that turned out not to exist</h2>
 *
 * <p>The card asked for {@code runtimeExecutable} to be "validated at WRITE time
 * as well as at run time". Measured on 2026-08-31: <b>there is no run-time value
 * guard to mirror.</b> {@link LaunchSupervisor} resolves the executable and
 * hands it to {@link ProcessBuilder}; nothing inspects what it is. The only
 * thing standing between a launch file and a process is the permission gate,
 * which prompts the operator — an authority check, not a validator.
 *
 * <p>Inventing an allowlist here would therefore have been the worse of two
 * mistakes: a file spectroscope refuses to write is one it will happily run from
 * an editor five seconds later, so the refusal would teach a security boundary
 * that does not exist. What IS mirrored is the guard that does exist. Every
 * string out of a launch file passes {@code LaunchTools.clean}, which flattens
 * control characters, because a crafted entry name carrying newlines forged
 * three invented configurations into a transcript on 2026-08-13. The write path
 * refuses what the read path has to defuse: this product does not author a file
 * its own reader would have to make safe.
 *
 * <p>The other refusals are integrity rather than safety — an entry with no
 * name cannot be addressed, an entry with neither a command nor an
 * {@link LaunchEntry#address()} is a configuration for nothing, a port outside
 * 1–{@value #MAX_PORT} is not one anything can bind, and two entries of one name
 * make {@link LaunchFile#find(String)} a coin toss. Every one of them refuses
 * the WHOLE write: a half-written launch file is worse than none, because the
 * reader would load it.
 *
 * <p><b>The line for "can it be reached" is {@link LaunchEntry#address()}, not
 * {@code url}.</b> A port-only attach entry — no command, no url, just a port —
 * is one the reader parses, {@code address()} turns into
 * {@code http://localhost:<port>/} and {@link LaunchSupervisor} waits on.
 * Refusing it here would have forked the format by accident: spectroscope would
 * decline to author a file it reads without complaint.
 */
public final class LaunchWriter {

    /** The version every file in the measured corpus carried; card 202's schema. */
    public static final String VERSION = "0.0.1";

    /** The largest port a socket can hold. */
    private static final int MAX_PORT = 65535;

    private static final ObjectMapper JSON = new ObjectMapper();

    private LaunchWriter() {
    }

    /**
     * Writes this project's launch file, replacing whatever was there.
     *
     * @param projectRoot the folder the operator has open
     * @param entries     the configurations, in the order they should be read
     * @return the file that was written
     * @throws IllegalArgumentException when an entry is one this product will not
     *                                  author — nothing is written in that case
     * @throws IOException              when the folder or the file cannot be written
     */
    public static Path write(Path projectRoot, List<LaunchEntry> entries) throws IOException {
        String text = render(entries);
        Path file = projectRoot.resolve(LaunchFile.OURS);
        Files.createDirectories(SpectroDir.in(projectRoot));
        Files.writeString(file, text, StandardCharsets.UTF_8);
        return file;
    }

    /**
     * The file's text, without touching the file system.
     *
     * <p>Separate from {@link #write(Path, List)} so the validation runs before
     * any directory is created: a refusal must not leave a {@code .spectro}
     * behind that the operator did not ask for.
     *
     * @param entries the configurations
     * @return the JSON a launch file carries, newline-terminated
     * @throws IllegalArgumentException when an entry is one this product will not author
     */
    public static String render(List<LaunchEntry> entries) {
        List<LaunchEntry> list = entries == null ? List.of() : entries;
        Set<String> names = new LinkedHashSet<>();
        for (LaunchEntry entry : list) {
            check(entry, names);
        }
        ObjectNode root = JSON.createObjectNode();
        root.put("version", VERSION);
        ArrayNode configurations = root.putArray("configurations");
        for (LaunchEntry entry : list) {
            ObjectNode node = configurations.addObject();
            node.put("name", entry.name().strip());
            if (entry.runtimeExecutable() != null) {
                node.put("runtimeExecutable", entry.runtimeExecutable());
                ArrayNode args = node.putArray("runtimeArgs");
                entry.runtimeArgs().forEach(args::add);
            }
            if (entry.port() != null) {
                node.put("port", entry.port());
            }
            if (entry.url() != null) {
                node.put("url", entry.url());
            }
        }
        DefaultPrettyPrinter printer = new DefaultPrettyPrinter();
        printer.indentArraysWith(DefaultIndenter.SYSTEM_LINEFEED_INSTANCE);
        try {
            return JSON.writer(printer).writeValueAsString(root) + "\n";
        } catch (com.fasterxml.jackson.core.JsonProcessingException impossible) {
            // Every node here was built from strings and ints a moment ago.
            throw new IllegalStateException("the launch file could not be rendered", impossible);
        }
    }

    /** One entry, or a sentence saying why this product will not author it. */
    private static void check(LaunchEntry entry, Set<String> seen) {
        if (entry == null) {
            throw new IllegalArgumentException("a launch configuration cannot be null");
        }
        String name = entry.name() == null ? "" : entry.name().strip();
        if (name.isEmpty()) {
            throw new IllegalArgumentException(
                    "a launch configuration needs a name — nothing can address it without one");
        }
        if (!seen.add(name)) {
            throw new IllegalArgumentException("two launch configurations are both called \""
                    + name + "\"; a name has to reach one entry");
        }
        if (entry.port() != null && (entry.port() < 1 || entry.port() > MAX_PORT)) {
            throw new IllegalArgumentException("\"" + name + "\" carries port " + entry.port()
                    + ", which is not a port anything can bind (1–" + MAX_PORT + ")");
        }
        // The line is address(), not url. A port-only entry attaches — the reader
        // turns it into http://localhost:<port>/ and LaunchSupervisor waits on
        // that — so refusing it here would fork the format: the product would
        // decline to author a file it reads without complaint. What is refused is
        // an entry with no command AND no address, which names nothing at all.
        if (entry.attaches() && entry.address() == null) {
            throw new IllegalArgumentException("\"" + name + "\" names neither a"
                    + " runtimeExecutable to start nor an address — a url or a port —"
                    + " to attach to");
        }
        refuseControls(name, "the name of \"" + name + "\"");
        refuseControls(entry.runtimeExecutable(), "the runtimeExecutable of \"" + name + "\"");
        refuseControls(entry.url(), "the url of \"" + name + "\"");
        for (String argument : entry.runtimeArgs()) {
            refuseControls(argument, "an argument of \"" + name + "\"");
        }
    }

    /**
     * Refuses a string the reader would have to flatten.
     *
     * <p>Only control characters, deliberately. A space is not one: an argument
     * carrying one is ordinary ({@code --message "hello world"}) and
     * {@link LaunchEntry#commandLine()} already quotes it so a sentence cannot
     * read it as two arguments.
     *
     * @param value the string as the caller wrote it, or null
     * @param where what to call it in the refusal
     */
    private static void refuseControls(String value, String where) {
        if (value == null) {
            return;
        }
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (Character.isISOControl(character)) {
                throw new IllegalArgumentException(where + " carries a control character"
                        + " (U+" + String.format("%04X", (int) character) + "); the reader"
                        + " would have to flatten it, so it is not written");
            }
        }
    }
}
