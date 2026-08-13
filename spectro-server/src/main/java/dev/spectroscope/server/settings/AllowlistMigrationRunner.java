package dev.spectroscope.server.settings;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.permission.AllowlistMigration;
import dev.spectroscope.core.permission.ToolTierMap;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.List;

/**
 * Card 199, criterion 8: migrate the process-wide settings files onto tiers once,
 * at boot, before any face can read or show them.
 *
 * <p>{@code SessionConnection} migrates too, because a workspace's own settings
 * only exist once a session has resolved one. This runner exists for the files
 * that are there from the start — {@code ~/.spectro/settings.json}, its legacy
 * {@code config.json}, and the launch directory's project file. Without it the
 * settings page could show an honest but misleading reading between boot and the
 * first run: an unmigrated {@code write_file} entry parses as a read entry,
 * which is what it would mean if somebody had written it today.
 *
 * <p>No gate decision was ever wrong in that window — a decision only happens
 * inside a run, and the run migrates first. What was wrong was the picture.
 *
 * <p>{@link AllowlistMigration#migrateFileOnce} decides "once" from its ledger
 * and never throws, so this is idempotent across restarts and a boot can never
 * fail on it.
 */
@Component
public class AllowlistMigrationRunner implements ApplicationRunner {

    private final Path launchDir;

    /** Production wiring: the directory the server was started in. */
    public AllowlistMigrationRunner() {
        this(Path.of(System.getProperty("user.dir")));
    }

    /**
     * @param launchDir the directory whose {@code .spectro/settings.json} joins the pass
     */
    public AllowlistMigrationRunner(Path launchDir) {
        this.launchDir = launchDir;
    }

    @Override
    public void run(ApplicationArguments args) {
        migrate();
    }

    /**
     * The pass itself. Visible for tests, which point {@code launchDir} at a
     * temp folder rather than starting a context.
     *
     * @return how many files this call actually rewrote
     */
    public int migrate() {
        ToolTierMap tiers = ToolTierMap.shipped();
        Path ledger = AllowlistMigration.defaultLedger();
        int rewritten = 0;
        for (Path file : List.of(SpectroConfig.USER_SETTINGS_PATH, SpectroConfig.CONFIG_PATH,
                launchDir.resolve(SpectroConfig.PROJECT_SETTINGS))) {
            if (AllowlistMigration.migrateFileOnce(file, tiers, ledger)) {
                rewritten++;
            }
        }
        return rewritten;
    }
}
