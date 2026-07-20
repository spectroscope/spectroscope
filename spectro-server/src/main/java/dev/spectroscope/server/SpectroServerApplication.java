package dev.spectroscope.server;

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
        SpringApplication.run(SpectroServerApplication.class, args);
    }
}
