package dev.spectroscope.core.peer;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;

/**
 * A process as the registry knows it: its pid and its start instant, which
 * together survive pid reuse (card 502 criterion 2).
 *
 * @param pid       the process id
 * @param procStart the start instant, ISO 8601 truncated to the millisecond
 */
public record ProcessIdentity(long pid, String procStart) {

    /** @return this process */
    public static ProcessIdentity current() {
        ProcessHandle self = ProcessHandle.current();
        return new ProcessIdentity(self.pid(), self.info().startInstant().map(ProcessIdentity::format).orElse(""));
    }

    /**
     * A live process by pid.
     *
     * @param pid the process id
     * @return its identity, or empty when no such process is alive or its start is unknown
     */
    public static Optional<ProcessIdentity> of(long pid) {
        return ProcessHandle.of(pid)
                .filter(ProcessHandle::isAlive)
                .flatMap(handle -> handle.info().startInstant())
                .map(start -> new ProcessIdentity(pid, format(start)));
    }

    /** @param instant a start instant @return its registry spelling */
    static String format(Instant instant) {
        return instant.truncatedTo(ChronoUnit.MILLIS).toString();
    }
}
