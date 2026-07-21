package dev.spectroscope.server;

/**
 * The JSON body of {@code POST /api/fleet/{node}/gate} — an operator's answer to
 * a permission request a fleet node parked (block 4). Both fields are required:
 * {@code allow} is a boxed {@link Boolean} so a MISSING verdict is null (a 400),
 * never silently coerced to false — a missing answer must not deny a tool by
 * accident.
 *
 * @param callId the parked permission request's call id (from its
 *               permission_request event on the fleet stream)
 * @param allow  the verdict — true to run the tool, false to deny it
 */
public record GateAnswer(String callId, Boolean allow) {
}
