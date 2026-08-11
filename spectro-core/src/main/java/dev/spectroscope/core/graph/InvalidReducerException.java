package dev.spectroscope.core.graph;

/**
 * A channel claims to fold and has nothing to fold with.
 *
 * <p>Refused at declaration rather than at the first fold, because a reducer is
 * only exercised on the SECOND write to its channel: an unusable one survives a
 * smoke test and then takes down a superstep in production with a failure that
 * names neither the channel nor the reducer.</p>
 */
public class InvalidReducerException extends IllegalArgumentException {

    private static final long serialVersionUID = 1L;

    /**
     * @param message names the channel
     */
    public InvalidReducerException(String message) {
        super(message);
    }
}
