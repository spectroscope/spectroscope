package dev.spectroscope.server;

import jakarta.servlet.http.HttpServletRequest;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Reports whether Docker is usable on this machine, so the Observability
 * settings can offer the right next step instead of a command that cannot work.
 * Card 137.
 *
 * <p>This endpoint grants nothing. It starts no container, spawns no process
 * and takes no parameter: the only impure thing it does is read a socket and a
 * few directory entries. It is deliberately NOT gated behind any
 * allow-Docker switch, because gating a read-only probe behind a dangerous flag
 * would teach operators to turn the dangerous flag on just to see a status
 * line.
 *
 * <p>Three states, and every one of them is read off the socket:
 * <ul>
 *   <li>{@code absent}: no {@code docker} executable found AND nothing
 *       answering on the socket. Both halves, because either one alone is a
 *       measured false negative.
 *   <li>{@code unreachable}: the daemon did not answer, but something says
 *       Docker is here anyway (an executable, a remote {@code DOCKER_HOST}, or
 *       a socket that refused us). A permission failure lands here whatever the
 *       binary walk found, never in {@code absent}: the install is fine, so
 *       telling that operator to download Docker again is a lie.
 *   <li>{@code ready}: the daemon answered {@code 200}.
 * </ul>
 *
 * <p>Neither half of the evidence is trusted on its own, and both directions
 * were measured. A binary hit alone is never {@code ready}: Docker Desktop
 * leaves its binary in place while quit, so presence-only detection reports a
 * working install to an operator whose next command will fail. A binary miss
 * alone is never {@code absent}: a GUI-launched app inherits the launchd
 * {@code PATH} and cannot see {@code /usr/local/bin/docker}, so PATH-only
 * detection told an operator with a running daemon to go and install Docker.
 *
 * <p>It wears the full local fence ({@link FleetController#isLocalOrigin} plus
 * the Origin check) and answers 404 with no body to anyone else, because the
 * answer fingerprints the operator's machine. No {@code @CrossOrigin}.
 */
@RestController
public class DockerStatusController {

    /** Seam: is a {@code docker} executable on PATH at all? */
    private final BooleanSupplier binaryPresent;
    /** Seam: is the compose v2 CLI plugin installed? */
    private final BooleanSupplier composePresent;
    /** Seam: the raw {@code DOCKER_HOST}, or null when unset. */
    private final Supplier<String> dockerHost;
    /** Seam: ask a socket path whether a daemon answers there. */
    private final DockerPing.Probe ping;

    /** Spring wiring: the real binary walk, the real plugin walk, the real socket. */
    public DockerStatusController() {
        this(DockerPing::binaryInstalled,
                DockerPing::composePluginPresent,
                () -> System.getenv("DOCKER_HOST"),
                DockerPing::pingUnixSocket);
    }

    /**
     * Seam constructor for tests.
     *
     * @param binaryPresent  the PATH probe
     * @param composePresent the compose plugin probe
     * @param dockerHost     the {@code DOCKER_HOST} source
     * @param ping           the socket probe
     */
    DockerStatusController(BooleanSupplier binaryPresent, BooleanSupplier composePresent,
            Supplier<String> dockerHost, DockerPing.Probe ping) {
        this.binaryPresent = binaryPresent;
        this.composePresent = composePresent;
        this.dockerHost = dockerHost;
        this.ping = ping;
    }

    /**
     * Report Docker's state on this machine.
     *
     * @param request the servlet request, for the local-origin fence
     * @return 404 with no body for a non-local caller, a rebound Host or a
     *         cross-site Origin; else {docker, compose, remote, detail} where
     *         detail is one honest sentence and never a stack trace
     */
    @GetMapping("/api/docker/status")
    public ResponseEntity<Map<String, Object>> status(HttpServletRequest request) {
        if (!FleetController.isLocalOrigin(request)
                || !FleetController.originIsLoopbackOrAbsent(request)) {
            return ResponseEntity.notFound().build();
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("compose", composePresent.getAsBoolean());

        boolean installed = binaryPresent.getAsBoolean();
        String host = dockerHost.get();
        if (DockerPing.isRemote(host)) {
            // Someone else's machine. We do not probe it, and we do not guess
            // at its state: "unreachable" here means unreachable BY THIS PROBE,
            // which is the only thing we actually measured.
            out.put("docker", "unreachable");
            out.put("remote", true);
            out.put("detail", "DOCKER_HOST names a remote daemon (" + DockerPing.schemeOf(host)
                    + "); this probe only speaks to a local socket.");
            return ResponseEntity.ok(out);
        }

        out.put("remote", false);
        String socket = DockerPing.socketPathIn(host);
        if (socket == null) {
            socket = DockerPing.defaultSocketPath();
        }
        try {
            if (ping.ping(socket)) {
                // A daemon that answers ends the argument. Whether we also found
                // the CLI is a detail about our own PATH, not about the machine.
                out.put("docker", "ready");
                out.put("detail", "the docker daemon answered.");
            } else {
                out.put("docker", "unreachable");
                out.put("detail", "something answered on " + socket + ", but not a docker daemon.");
            }
        } catch (Exception noAnswer) {
            boolean denied = deniedPermission(noAnswer);
            if (denied) {
                // Being refused IS evidence of an install: something owns that
                // socket and is turning us away. The binary walk gets no vote
                // here, because it can miss a real CLI (a stripped launchd PATH
                // and an install outside the handful of directories we know),
                // and a miss must never downgrade a refusal into "not
                // installed" plus a download link.
                out.put("docker", "unreachable");
                out.put("detail", "the docker socket " + socket + " refused us: " + reason(noAnswer));
            } else if (installed) {
                out.put("docker", "unreachable");
                out.put("detail", "docker is installed, the daemon did not answer on " + socket
                        + ": " + reason(noAnswer));
            } else {
                // Both halves came up empty, which is the only evidence that
                // earns the sentence "not installed" and the download link
                // underneath it.
                out.put("docker", "absent");
                out.put("detail", "no docker executable found, and nothing answered on "
                        + socket + ".");
            }
        }
        return ResponseEntity.ok(out);
    }

    /**
     * One honest clause about a failed probe. Never a stack trace, and never an
     * empty string: a blank detail reads as "we did not look".
     *
     * @param failure what the probe threw
     * @return a short clause, with permission failures named as such
     */
    private static String reason(Exception failure) {
        String text = text(failure);
        // A permission failure is a different fix from a stopped daemon, so it
        // gets said out loud rather than folded into "did not answer".
        return deniedPermission(failure) ? "permission denied (" + text + ")" : text;
    }

    /**
     * Was the probe turned away rather than left unanswered? The class is asked
     * first because it is the reliable half; the message is a fallback for the
     * platforms that hand an {@code EACCES} back as a plain
     * {@link java.io.IOException}.
     *
     * @param failure what the probe threw
     * @return true when this is a refusal, not an absence
     */
    private static boolean deniedPermission(Exception failure) {
        return failure instanceof java.nio.file.AccessDeniedException
                || failure instanceof SecurityException
                || text(failure).toLowerCase(Locale.ROOT).contains("permission")
                || text(failure).toLowerCase(Locale.ROOT).contains("not permitted");
    }

    /**
     * The failure's own words, or its class name when it has none.
     *
     * @param failure what the probe threw
     * @return a non-blank description
     */
    private static String text(Exception failure) {
        String message = failure.getMessage();
        return message == null || message.isBlank()
                ? failure.getClass().getSimpleName()
                : message.strip();
    }
}
