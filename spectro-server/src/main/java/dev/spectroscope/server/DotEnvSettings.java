package dev.spectroscope.server;

import dev.spectroscope.core.config.SpectroConfig;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
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
 * {@code spring.datasource.url=…} would be silently obeyed. The two names below
 * are the ones the UI can write, and they are the only ones this reads.</p>
 *
 * <p>Public since card 186: main() applies it from the root package, and SessionsController in .session reads WRITABLE, HUB_PORT and read().</p>
 */
public final class DotEnvSettings {

    private DotEnvSettings() {}

    /** The hub's port opt-in; blank keeps the hub off. */
    public static final String HUB_PORT = "SPECTRO_HUB_PORT";
    /** The spawn opt-in; anything but {@code true} keeps it off. */
    static final String ALLOW_SPAWN = "SPECTRO_ALLOW_SPAWN";

    /**
     * The settings the UI may save, and the only names read back out of the file.
     * Adding one here is a security decision: it becomes remotely settable by
     * anything that can reach the origin-fenced endpoint.
     */
    public static final List<String> WRITABLE = List.of(HUB_PORT, ALLOW_SPAWN);

    /** The property source's name — also how a test finds it. */
    static final String SOURCE = "spectroDotEnvSettings";

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
        Map<String, Object> found = new LinkedHashMap<>();
        if (!Files.isRegularFile(file)) {
            return found;
        }
        List<String> lines;
        try {
            lines = Files.readAllLines(file);
        } catch (IOException | RuntimeException unreadable) {
            return found;
        }
        for (String line : lines) {
            String trimmed = line.strip();
            int at = trimmed.indexOf('=');
            if (trimmed.isEmpty() || trimmed.startsWith("#") || at <= 0) {
                continue;
            }
            String name = trimmed.substring(0, at).strip();
            if (WRITABLE.contains(name)) {
                // Last wins, matching the writer, which appends rather than
                // rewriting in place.
                found.put(name, trimmed.substring(at + 1));
            }
        }
        return found;
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
