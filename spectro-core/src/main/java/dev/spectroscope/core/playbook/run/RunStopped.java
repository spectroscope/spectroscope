package dev.spectroscope.core.playbook.run;

/** Thrown by a node body to end the run with a named reason; the engine lets it through. */
public final class RunStopped extends RuntimeException {
    private final String reason;

    /**
     * @param reason one of {@link RunStop}
     * @param detail what a person reads about it
     */
    public RunStopped(String reason, String detail) {
        super(detail);
        this.reason = reason;
    }

    /** @return the stop reason */
    public String reason() {
        return reason;
    }
}
