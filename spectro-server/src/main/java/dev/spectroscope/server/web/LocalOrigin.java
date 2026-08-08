package dev.spectroscope.server.web;

import jakarta.servlet.http.HttpServletRequest;

import java.net.InetAddress;
import java.net.UnknownHostException;

/**
 * The local fence, as a utility rather than as four static methods parked
 * inside a REST controller.
 *
 * <p>These bodies lived in {@code FleetController} and were called from
 * everywhere: the reference graph over this module showed that controller
 * carrying seventeen inbound edges, which read like a centre of gravity. Every
 * one of them was a call to one of these helpers, and nothing else in the class
 * was reached from outside. Roughly a quarter of the module's apparent coupling
 * was a misplaced utility, and moving it here drops the largest connected
 * component from fifty classes to thirty-eight.</p>
 *
 * <p>{@link ApiLocalFence} applies {@link #isLocalOrigin} once for the whole
 * {@code /api} surface. The per-endpoint checks that remain are the stricter
 * ones — {@link #originIsLoopbackOrAbsent} for CSRF, {@code consumes=json}, the
 * spawn opt-in — and they still run on top of it.</p>
 *
 * <p>All four are {@code public} deliberately, and not because they are wanted
 * on the module's surface. This class is bound for {@code .web} while its
 * callers end up in nine other packages, and {@code NodeSpawnerTest} exercises
 * the two host helpers from what becomes {@code .fleet}. Declaring the final
 * visibility here rather than widening later keeps every package-move commit a
 * pure move, which is what makes those commits reviewable by the rule "the diff
 * contains nothing but package and import lines".</p>
 */
public final class LocalOrigin {

    private LocalOrigin() {
    }

    /**
     * The shared fence for every local-only endpoint (fleet control, key save,
     * bundle scaffold, settings, the OTLP probe — also called cross-package):
     * a loopback remote address AND a localhost Host header. The Host check is
     * the DNS-rebinding defense — a rebinding page reaches loopback but carries
     * the attacker's Host (which JS cannot forge), so it fails here; loopback
     * alone would let it through.
     *
     * @param request the servlet request
     * @return true only for a loopback peer with a localhost Host
     */
    public static boolean isLocalOrigin(HttpServletRequest request) {
        return isLoopback(request.getRemoteAddr()) && isLocalHostName(request.getServerName());
    }

    /**
     * The CSRF half of the fence, shared like {@link #isLocalOrigin}: true when
     * {@code Origin} is absent (non-browser) or points at loopback. A cross-site
     * page's request arrives via loopback with a localhost Host, so only its
     * Origin header (the page's own domain, browser-set) betrays it.
     *
     * @param request the servlet request
     * @return whether the Origin is safe
     */
    public static boolean originIsLoopbackOrAbsent(HttpServletRequest request) {
        String origin = request.getHeader("Origin");
        if (origin == null || origin.isBlank()) {
            return true;
        }
        try {
            String host = java.net.URI.create(origin).getHost();
            return "localhost".equals(host) || "127.0.0.1".equals(host)
                    || "::1".equals(host) || "[::1]".equals(host);
        } catch (RuntimeException malformed) {
            return false;
        }
    }

    /** Whether a Host header names loopback (localhost or a loopback literal). */
    public static boolean isLocalHostName(String host) {
        if (host == null || host.isBlank()) {
            return false;
        }
        String h = host.trim().toLowerCase(java.util.Locale.ROOT);
        if (h.startsWith("[") && h.endsWith("]")) {
            h = h.substring(1, h.length() - 1); // an IPv6 literal's brackets
        }
        return h.equals("localhost") || h.equals("127.0.0.1")
                || h.equals("::1") || h.equals("0:0:0:0:0:0:0:1");
    }

    /**
     * Whether a servlet remote address is the loopback interface — half of the
     * local-origin gate. An unparseable address is refused (not trusted).
     *
     * @param remoteAddr the request's remote address
     * @return true only for a loopback address
     */
    public static boolean isLoopback(String remoteAddr) {
        if (remoteAddr == null || remoteAddr.isBlank()) {
            return false;
        }
        try {
            return InetAddress.getByName(remoteAddr).isLoopbackAddress();
        } catch (UnknownHostException unparseable) {
            return false;
        }
    }
}
