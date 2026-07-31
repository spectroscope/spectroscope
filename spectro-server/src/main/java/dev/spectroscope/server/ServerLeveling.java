package dev.spectroscope.server;

import dev.spectroscope.core.config.SpectroConfig;
import dev.spectroscope.core.leveling.Ladder;
import dev.spectroscope.core.leveling.LevelingRecorder;
import dev.spectroscope.core.leveling.LevelingState;
import dev.spectroscope.core.leveling.LevelingStore;
import dev.spectroscope.core.session.SessionStore;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

/**
 * The server's one leveling recorder, shared by the REST endpoints and by every
 * live session's tracing port. In-process singleton on purpose: the state file
 * has a single writer, and that writer is this server.
 *
 * <p>It also owns the fresh-home decision. A home that has never run an agent
 * and never saved a setting is offered the ladder; anything else gets
 * {@code checklist}, where the pill and the panel still track but nothing ever
 * locks. That rule comes straight from the stress test: locks are for people
 * meeting the product, never for someone who already has work in here.</p>
 */
final class ServerLeveling {

    private static volatile LevelingRecorder recorder;

    private ServerLeveling() {
    }

    /**
     * @return the process-wide recorder, built on first use
     */
    static LevelingRecorder recorder() {
        LevelingRecorder local = recorder;
        if (local == null) {
            synchronized (ServerLeveling.class) {
                local = recorder;
                if (local == null) {
                    LevelingState.Mode mode =
                            freshMode(SessionStore.SESSIONS_DIR, SpectroConfig.USER_SETTINGS_PATH);
                    local = new LevelingRecorder(Ladder.bundled(), LevelingStore.userStore(), mode);
                    if (mode == LevelingState.Mode.CHECKLIST) {
                        // A home with work in it is never asked to choose: it already has
                        // every surface, and an intro would be the product introducing
                        // itself to someone who has been using it for weeks.
                        local.introAnswered();
                    }
                    recorder = local;
                }
            }
        }
        return local;
    }

    /**
     * Decides how a home that has no leveling file yet should start.
     *
     * <p>Pure and parameterised so the rule is testable without a home
     * directory. It runs exactly once per home: the answer is written into the
     * state file on the first change, and a home is never downgraded later.</p>
     *
     * @param sessionsDir where session files live
     * @param settingsFile the user settings file
     * @return {@code LADDER} for an untouched home, {@code CHECKLIST} otherwise
     */
    static LevelingState.Mode freshMode(Path sessionsDir, Path settingsFile) {
        if (Files.exists(settingsFile) || hasSessions(sessionsDir)) {
            return LevelingState.Mode.CHECKLIST;
        }
        return LevelingState.Mode.LADDER;
    }

    private static boolean hasSessions(Path sessionsDir) {
        if (!Files.isDirectory(sessionsDir)) {
            return false;
        }
        try (Stream<Path> entries = Files.list(sessionsDir)) {
            return entries.anyMatch(p -> p.getFileName().toString().endsWith(".jsonl"));
        } catch (IOException unreadable) {
            return true;   // cannot tell: assume experienced, which locks nothing
        }
    }
}
