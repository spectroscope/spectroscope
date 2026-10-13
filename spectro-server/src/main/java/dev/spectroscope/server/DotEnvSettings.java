package dev.spectroscope.server;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.orchestrator.HubSettings;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Makes {@code ~/.spectro/.env} reachable by the settings the operator can save
 * from the UI — and by nothing else.
 *
 * <p><b>Why this exists.</b> API keys saved from the UI have always landed in
 * that file, and they work because {@code SpectroConfig.resolveApiKey} reads it
 * itself on every provider build. The fleet's own switches do not: they are
 * Spring {@code @Value} fields read out of the PROCESS environment at bean
 * creation ({@code FleetAggregator}, {@code NodeSpawner}), and a running JVM
 * cannot change its own {@code System.getenv}. So a Settings page that wrote
 * {@code SPECTRO_HUB_PORT} into that file without this class would have written
 * a value nothing ever read — a setting that looks saved and does nothing,
 * which is worse than no setting at all.</p>
 *
 * <p><b>Lowest precedence, deliberately.</b> This source is appended LAST, so a
 * real environment variable, a {@code -D} property and a launcher-loaded
 * {@code ./.env} all still win. The file is the fallback the UI can write, never
 * an override of what the operator started the process with.</p>
 *
 * <p><b>An allowlist, not a loader.</b> Only {@link #WRITABLE} is read out of
 * the file. That file also holds API keys, and lifting whatever it contains into
 * Spring's environment would put secrets into every property resolution, every
 * actuator surface and every error page that prints a property. Worse, a `.env`
 * is a file an operator edits: a line reading {@code JAVA_TOOL_OPTIONS=…} or
 * {@code spring.datasource.url=…} would be silently obeyed. The names below
 * are the ones the UI can write, and they are the only ones this reads.</p>
 *
 * <p>Public since card 186: main() applies it from the root package, and SessionsController in .session reads WRITABLE, HUB_PORT and read().</p>
 */
public final class DotEnvSettings {

    private DotEnvSettings() {}

    /** The hub's port; on its own it is also the old way to turn the hub on. */
    public static final String HUB_PORT = HubSettings.PORT;
    /** The hub's switch (card 585): true or false, the reader also takes on/off and yes/no. */
    public static final String HUB_ENABLED = HubSettings.ENABLED;
    /** The spawn opt-in; anything but {@code true} keeps it off. */
    static final String ALLOW_SPAWN = "SPECTRO_ALLOW_SPAWN";

    /**
     * The settings the UI may save, and the only names read back out of the file.
     * Adding one here is a security decision: it becomes remotely settable by
     * anything that can reach the origin-fenced endpoint.
     */
    public static final List<String> WRITABLE = List.of(HUB_ENABLED, HUB_PORT, ALLOW_SPAWN);

    /** The commented lines a write leaves behind for an unset hub setting, in this order. */
    private static final Map<String, String> COMMENTED_DEFAULTS = new LinkedHashMap<>();

    static {
        COMMENTED_DEFAULTS.put(HUB_ENABLED, "false");
        COMMENTED_DEFAULTS.put(HUB_PORT, String.valueOf(HubSettings.DEFAULT_PORT));
    }

    /** The property source's name — also how a test finds it. */
    public static final String SOURCE = "spectroDotEnvSettings";

    /**
     * Reads the allowlisted settings out of {@code ~/.spectro/.env}.
     *
     * <p>Parsed the same way the launchers parse it: {@code NAME=value}, one per
     * line, {@code #} comments and blanks skipped, the value taken verbatim
     * after the first {@code =}. No quote stripping and no escapes — a port and
     * a boolean have no use for either, and inventing a second grammar for this
     * file is how the two would drift.</p>
     *
     * @param file the env file
     * @return the values found, in file order; empty when the file is absent or
     *         unreadable, because a missing opt-in is exactly "off"
     */
    public static Map<String, Object> read(Path file) {
        // One reader for the server and the CLI doctor (card 585, review N2).
        return new LinkedHashMap<>(SpectroConfig.readDotEnv(file, WRITABLE));
    }

    /**
     * Card 585: after the app writes the file, an unset hub setting shows up as
     * a commented default line, {@code # SPECTRO_HUB_ENABLED=false} and
     * {@code # SPECTRO_HUB_PORT=7700}, so the owner sees the default and can
     * change it. The file also holds API keys: this goes through the one
     * locked, atomic writer ({@link SpectroConfig#updateDotEnv}), adds lines
     * and never drops or rewrites one, and adds each comment once.
     *
     * @param file the env file; an absent file is left absent
     * @throws IOException when the file cannot be read or written
     */
    public static void keepCommentedDefaults(Path file) throws IOException {
        if (!Files.isRegularFile(file) && !Files.isSymbolicLink(file)) {
            return;
        }
        SpectroConfig.updateDotEnv(file, DotEnvSettings::withCommentedDefaults);
    }

    /**
     * Saves one setting and leaves the commented defaults, in one locked,
     * atomic write: what the settings and key routes call.
     *
     * @param file  the env file
     * @param name  the name to set
     * @param value the value, written verbatim
     * @throws IOException when the file cannot be written
     */
    public static void save(Path file, String name, String value) throws IOException {
        SpectroConfig.updateDotEnv(file,
                lines -> withCommentedDefaults(SpectroConfig.withEnvValue(lines, name, value)));
    }

    /**
     * @param lines the file's lines
     * @return the same lines plus a commented default for each hub setting
     *         that has neither a non-blank value nor a commented line
     */
    static List<String> withCommentedDefaults(List<String> lines) {
        List<String> out = new ArrayList<>(lines);
        for (Map.Entry<String, String> entry : COMMENTED_DEFAULTS.entrySet()) {
            if (!setOrShown(lines, entry.getKey())) {
                out.add("# " + entry.getKey() + "=" + entry.getValue());
            }
        }
        return out;
    }

    /** @return true when the name has a non-blank value or a commented line */
    private static boolean setOrShown(List<String> lines, String name) {
        for (String line : lines) {
            String trimmed = line.strip();
            if (trimmed.startsWith("#")) {
                if (name.equals(SpectroConfig.envName(trimmed.substring(1)))) {
                    return true;
                }
            } else if (name.equals(SpectroConfig.envName(trimmed))
                    && !trimmed.substring(trimmed.indexOf('=') + 1).isBlank()) {
                return true;
            }
        }
        return false;
    }

    /**
     * Appends the file's allowlisted settings to an environment, at the lowest
     * precedence.
     *
     * @param environment the application environment
     */
    static void apply(ConfigurableEnvironment environment) {
        Map<String, Object> found = read(SpectroConfig.dotEnvPath());
        if (!found.isEmpty()) {
            environment.getPropertySources().addLast(new MapPropertySource(SOURCE, found));
        }
    }
}
