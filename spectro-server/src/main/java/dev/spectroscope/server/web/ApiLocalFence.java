package dev.spectroscope.server.web;

import dev.spectroscope.server.llm.ExplainController;

import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.util.UrlPathHelper;

import java.io.IOException;
import java.util.Set;

/**
 * The local fence for the whole REST surface, applied once instead of per
 * handler (card 74). Every {@code /api} request must arrive from a loopback
 * peer carrying a localhost {@code Host} — the pair that defeats DNS
 * rebinding, since a rebound page reaches loopback exactly like the real UI but
 * carries the attacker's Host, which its JavaScript cannot forge.
 *
 * <p>A filter rather than more copies of the check, for three reasons the
 * per-handler form cannot give:</p>
 * <ul>
 *   <li>It is <em>default-deny</em>. Sixteen handlers called
 *       {@link LocalOrigin#isLocalOrigin} and twelve did not, and nothing
 *       said which list a new endpoint belonged on. Here the answer for a new
 *       endpoint is "fenced", and leaving one open costs a named line in
 *       {@link #OPEN} that a reader and a drift test can both see.</li>
 *   <li>It runs <em>before argument binding</em>. A handler fence sits behind
 *       {@code @RequestBody}, so Spring parses the caller's whole body into an
 *       object before anything looks at the Host — the explain DoS this card
 *       carries as its second half.</li>
 *   <li>It covers the paths a handler fence keeps missing, including
 *       {@code DELETE /api/sessions/{id}}, the one destructive endpoint that
 *       was still answering any origin.</li>
 * </ul>
 *
 * <p>It only ever <em>adds</em> a refusal. The stricter per-endpoint checks
 * (Origin for CSRF, {@code consumes=json}, the spawn opt-in) stay exactly where
 * they are and still run; this is the floor under them, not a replacement. So
 * no endpoint gets weaker, and the published fence classes in
 * {@code docs/api-collections/endpoints.json} stay readable as "host, plus
 * whatever else the row says".</p>
 *
 * <p>Refusals are a blank 404, never a 403 — the module's refusal shape, so a
 * refused caller cannot fingerprint the server.</p>
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public class ApiLocalFence implements Filter {

    /** Everything below this prefix is fenced unless {@link #OPEN} names it. */
    private static final String API_PREFIX = "/api/";

    /**
     * The endpoints that stay open on purpose. {@code /api/health} answers
     * {@code {"status":"ok"}} and nothing else: the desktop shell polls it
     * before there is a UI to be same-origin with, and being reachable IS the
     * entire signal, so there is no operator content here for a rebound page to
     * take. Every other path pays the fence.
     */
    private static final Set<String> OPEN = Set.of("/api/health");

    /**
     * Whether a path is deliberately left unfenced. The drift test reads this
     * so the published fence table cannot quietly disagree with the code.
     *
     * @param path the request path, context path already stripped
     * @return true when the path is on the open list
     */
    public static boolean isOpen(String path) {
        return OPEN.contains(path);
    }

    @Override
    public void doFilter(ServletRequest servletRequest, ServletResponse servletResponse, FilterChain chain)
            throws IOException, ServletException {
        HttpServletRequest request = (HttpServletRequest) servletRequest;
        HttpServletResponse response = (HttpServletResponse) servletResponse;

        String path = pathOf(request);
        if (!path.startsWith(API_PREFIX) || isOpen(path)) {
            chain.doFilter(servletRequest, servletResponse);
            return;
        }
        if (!LocalOrigin.isLocalOrigin(request)) {
            response.setStatus(HttpServletResponse.SC_NOT_FOUND);
            return;
        }
        // Being upstream of argument binding is the only place a body cap can
        // act BEFORE the body becomes an object. Honest about its reach: a
        // chunked request declares no length and falls through to the handler's
        // own character check, which is where it always was.
        long declared = request.getContentLengthLong();
        if (declared > bodyCapFor(path)) {
            response.setStatus(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
            return;
        }
        chain.doFilter(servletRequest, servletResponse);
    }

    /**
     * The largest request body this path may declare.
     *
     * @param path the request path
     * @return the cap in bytes, or {@link Long#MAX_VALUE} where the handler owns the limit
     */
    private static long bodyCapFor(String path) {
        return "/api/explain".equals(path) ? ExplainController.MAX_BODY_BYTES : Long.MAX_VALUE;
    }

    /**
     * The path as the MAPPING will read it: context path removed, percent
     * escapes decoded, semicolon parameters dropped.
     *
     * <p>Reading the raw target here was a hole, and a measured one: a rebound
     * page asking for {@code /%61pi/config} carried no literal {@code /api/},
     * so a raw match waved it through while the container decoded it and handed
     * it to the handler — full config, full system context, and a DELETE that
     * removed a session from disk. The rule is therefore not "decode", it is
     * "see what the dispatcher sees", which is what {@link UrlPathHelper}'s
     * default instance is: the same helper, the same single decode, no second
     * opinion to disagree with.</p>
     *
     * @param request the request being filtered
     * @return the decoded path within the application
     */
    private static String pathOf(HttpServletRequest request) {
        return UrlPathHelper.defaultInstance.getPathWithinApplication(request);
    }
}
