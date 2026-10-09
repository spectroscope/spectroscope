package dev.spectroscope.core.copilot;

import java.io.IOException;

/**
 * The GitHub OAuth device flow, as the sign-in of card 495 uses it: ask for a
 * code, show it, poll until the user confirmed it in the browser, and refresh
 * an expiring token later.
 *
 * <p>The flow is GitHub's (docs.github.com, "Authorizing OAuth apps", Device
 * flow, read 2026-10-10). Its answers are passed on in GitHub's own words: a
 * refusal carries the {@code error} code and the {@code error_description}
 * the response held, never a sentence made up here.
 */
public interface DeviceFlow {

    /**
     * Asks GitHub for a device code and a user code.
     *
     * @return the codes, the address to open and the polling interval
     * @throws IOException when GitHub cannot be reached or refuses the request
     */
    DeviceCode start() throws IOException;

    /**
     * Asks once whether the user has confirmed the code.
     *
     * @param code the code {@link #start()} returned
     * @return pending, slow down, granted or refused
     * @throws IOException when GitHub cannot be reached
     */
    Poll poll(DeviceCode code) throws IOException;

    /**
     * Trades a refresh token for a new access token. Device flow tokens need
     * no client secret for this (docs.github.com, "Refreshing user access
     * tokens", read 2026-10-10).
     *
     * @param refreshToken the refresh token of the current grant
     * @return the new grant
     * @throws Refused when GitHub refuses the refresh token
     * @throws IOException when GitHub cannot be reached
     */
    Grant refresh(String refreshToken) throws IOException;

    /**
     * Reads the login of the account a token belongs to.
     *
     * @param accessToken the token
     * @return the GitHub login
     * @throws Refused when GitHub refuses the token
     * @throws IOException when GitHub cannot be reached
     */
    String login(String accessToken) throws IOException;

    /**
     * What {@link #start()} returned. {@link #toString()} shows neither code.
     *
     * @param deviceCode       the secret code the app polls with
     * @param userCode         the code the user types in the browser
     * @param verificationUri  the address the user opens
     * @param expiresInSeconds how long the codes stay valid
     * @param intervalSeconds  the shortest wait between two polls
     */
    record DeviceCode(String deviceCode, String userCode, String verificationUri, long expiresInSeconds,
                      long intervalSeconds) {
        @Override
        public String toString() {
            return "DeviceCode[verificationUri=" + verificationUri + ", expiresInSeconds=" + expiresInSeconds
                    + ", intervalSeconds=" + intervalSeconds + "]";
        }
    }

    /**
     * A granted token. {@link #toString()} shows neither token.
     *
     * @param accessToken             the token for the runtime
     * @param expiresInSeconds        seconds until it expires, 0 when it does not
     * @param refreshToken            the refresh token, or null when the token does not expire
     * @param refreshExpiresInSeconds seconds until the refresh token expires, 0 when unknown
     */
    record Grant(String accessToken, long expiresInSeconds, String refreshToken, long refreshExpiresInSeconds) {
        @Override
        public String toString() {
            return "Grant[expiresInSeconds=" + expiresInSeconds + ", refreshable=" + (refreshToken != null)
                    + ", refreshExpiresInSeconds=" + refreshExpiresInSeconds + "]";
        }
    }

    /** One answer to {@link #poll}. */
    sealed interface Poll permits Pending, SlowDown, Granted, Denied {
    }

    /** The user has not confirmed the code yet. */
    record Pending() implements Poll {
    }

    /**
     * Polling was too fast.
     *
     * @param intervalSeconds the interval GitHub asks for from now on
     */
    record SlowDown(long intervalSeconds) implements Poll {
    }

    /**
     * The user confirmed the code.
     *
     * @param grant the token
     */
    record Granted(Grant grant) implements Poll {
    }

    /**
     * GitHub ended the flow.
     *
     * @param error       GitHub's error code, such as {@code access_denied}
     * @param description GitHub's {@code error_description}, or null when it sent none
     */
    record Denied(String error, String description) implements Poll {
    }

    /** GitHub refused a request; the message is GitHub's description, or its error code. */
    final class Refused extends IOException {

        private static final long serialVersionUID = 1L;

        /** GitHub's error code, or the HTTP status as text. */
        private final String error;

        /**
         * A refusal.
         *
         * @param error       GitHub's error code, or the HTTP status as text
         * @param description GitHub's description, or null
         */
        public Refused(String error, String description) {
            super(description == null || description.isBlank() ? error : description);
            this.error = error;
        }

        /** {@return GitHub's error code, or the HTTP status as text} */
        public String error() {
            return error;
        }
    }
}
