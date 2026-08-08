package dev.spectroscope.server;

import dev.spectroscope.server.leveling.ServerLeveling;
import dev.spectroscope.server.settings.BundledSkills;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * The entry point of the second face. Spring Boot boots web + WebSocket, serves
 * the built React UI from classpath:/static, and wires the socket handler and
 * REST controllers below. No business logic lives here — everything "clever"
 * stays in spectro-core.
 */
@SpringBootApplication
public class SpectroServerApplication {
    /**
     * Boots the embedded server — Spring Boot picks up this package's handler
     * and controllers and serves the UI on the configured port (default 8080).
     *
     * @param args standard Spring Boot arguments (e.g. {@code --server.port})
     */
    public static void main(String[] args) {
        // Leveling decides what kind of home this is FIRST, and the order is
        // load-bearing: ensureSeeded below writes ~/.spectro/settings.json on a
        // first boot whenever SPECTRO_* vars are set, and a home with a settings
        // file reads as experienced. Deciding afterwards would hand `checklist`
        // to exactly the newcomers the ladder exists for — verified live, it did.
        try {
            ServerLeveling.recorder();
        } catch (Throwable levelingIsNotWorthABoot) {
            // Catching Throwable on purpose: a damaged levels.json surfaces as an
            // ExceptionInInitializerError from the ladder's static holder, and a
            // nicety must never be the reason a server refuses to start.
            System.err.println("leveling: unavailable at boot, continuing without it ("
                    + levelingIsNotWorthABoot + ")");
        }
        // First boot: materialize the env base into ~/.spectro/settings.json once,
        // before anything reads the config hierarchy — see SpectroConfig.ensureSeeded.
        dev.spectroscope.core.config.SpectroConfig.ensureSeeded(System.getenv());
        // Apply the config-effective level (defaults <
        // SPECTRO_LOG_LEVEL < the settings files) once per process, before Boot
        // starts chattering — the shared logback.xml from spectro-cli set the
        // pattern.
        dev.spectroscope.cli.LogSetup.apply(
                dev.spectroscope.core.config.SpectroConfig.load(
                        dev.spectroscope.core.config.SpectroConfig.Overrides.none()).logLevel());
        // How much room this JVM actually got, said out loud once. Four launch
        // paths hand us -XX:MaxRAMPercentage (spectro-serve, the desktop shell,
        // bootRun, the CLI start script) and a fifth cannot: a plain
        // `java -jar spectro-server-x.y.z.jar` is assembled by no script we own,
        // so no build change reaches it. This line is what covers that path. It
        // prints the share as well as the ceiling, because a 25% share is how a
        // launcher that quietly stopped passing the flag shows itself.
        // INFO lands in ~/.spectro/logs/spectroscope.log, which the log panel
        // shows; the below-the-floor case is WARN and reaches the console too.
        dev.spectroscope.core.config.HeapBudget heap =
                dev.spectroscope.core.config.HeapBudget.measure();
        org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(SpectroServerApplication.class);
        log.info(heap.line());
        heap.warning().ifPresent(log::warn);
        // Card 90: the bundled skills reach ~/.spectro/skills exactly once —
        // absent-only + ledgered, a courtesy that must never break the boot.
        BundledSkills.seedFromClasspath();
        // The two fleet switches the UI can save land in ~/.spectro/.env, and a
        // running JVM cannot change its own environment — so without this they
        // would be written and never read. Appended LAST, so a real env var, a
        // -D property and a launcher-loaded ./.env all still win; see
        // DotEnvSettings for why only two names are lifted out of that file.
        SpringApplication app = new SpringApplication(SpectroServerApplication.class);
        app.addInitializers(ctx -> DotEnvSettings.apply(ctx.getEnvironment()));
        app.run(args);
    }
}
