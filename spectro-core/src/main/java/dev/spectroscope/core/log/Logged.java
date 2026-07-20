package dev.spectroscope.core.log;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Arrays;
import java.util.stream.Collectors;

/**
 * Autologging via injection, container-free (the owner's logging-night goal):
 * a JDK dynamic proxy around any PORT interface (LlmProvider, Tool,
 * McpTransport, …) that logs method entry (abbreviated args), exit (duration)
 * and thrown exceptions — without a single hand-written log statement at the
 * call sites. TracingProvider is the house precedent for decorating a port;
 * this is the generic, reflective sibling.
 *
 * <p>Contract: behavior-identical by construction. Results pass through
 * untouched, exceptions rethrow as the SAME object (the
 * InvocationTargetException is unwrapped), Object methods (toString/equals/
 * hashCode) are never treated as port calls. Work methods (with arguments —
 * execute, stream, fetch, …) log at DEBUG; zero-arg METADATA methods (name,
 * description, inputSchema, tier, …) drop to TRACE so they never bury the
 * work calls. At the default INFO level the proxy is silent and adds nothing
 * but one enabled-check per call. Return values are deliberately NOT logged
 * (a DOM dump or base64 image must never flood the log); args are clipped
 * per argument.</p>
 */
public final class Logged {

    /** Per-argument preview cap — enough to recognize a call, never a payload dump. */
    static final int ARG_PREVIEW_CHARS = 120;

    private static final long NANOS_PER_MILLI = 1_000_000L;

    /** Static utility — never instantiated. */
    private Logged() {}

    /**
     * Wraps a port in the autologging proxy.
     *
     * @param iface    the PORT interface to instrument — also names the logger
     * @param delegate the real implementation every call forwards to
     * @param <T>      the port type
     * @return a proxy logging entry/exit/exceptions at DEBUG, else behavior-identical
     */
    public static <T> T wrap(Class<T> iface, T delegate) {
        Logger log = LoggerFactory.getLogger(iface);
        return iface.cast(Proxy.newProxyInstance(
                iface.getClassLoader(),
                new Class<?>[] {iface},
                (proxy, method, args) -> invokeLogged(log, method, delegate, args)));
    }

    /**
     * One proxied call: forward-only for Object methods and below DEBUG,
     * entry/exit/exception records otherwise — the exception always rethrows
     * as the original object.
     *
     * @param log      the port's logger
     * @param method   the invoked interface method
     * @param delegate the real implementation
     * @param args     the call arguments; may be null (no-arg methods)
     * @return the delegate's untouched result
     * @throws Throwable the delegate's original exception, unwrapped
     */
    private static Object invokeLogged(Logger log, Method method, Object delegate, Object[] args)
            throws Throwable {
        boolean portCall = method.getDeclaringClass() != Object.class;
        // Zero-arg methods are metadata by port convention (name(),
        // description(), inputSchema(), tier(), providerName(), …) — logging
        // them at DEBUG would bury the work calls, so they drop to TRACE.
        boolean metadata = method.getParameterCount() == 0;
        boolean enabled = metadata ? log.isTraceEnabled() : log.isDebugEnabled();
        if (!portCall || !enabled) {
            return forward(method, delegate, args);
        }
        record(log, metadata, "{}({}) — entry", method.getName(), renderArgs(args));
        long start = System.nanoTime();
        try {
            Object result = forward(method, delegate, args);
            record(log, metadata, "{} — ok in {} ms", method.getName(),
                    (System.nanoTime() - start) / NANOS_PER_MILLI);
            return result;
        } catch (Throwable failure) {
            record(log, metadata, "{} — threw {} after {} ms", method.getName(),
                    failure.toString(), (System.nanoTime() - start) / NANOS_PER_MILLI);
            throw failure;
        }
    }

    /**
     * One record at the level the method class dictates — TRACE for metadata,
     * DEBUG for work methods.
     *
     * @param log      the port's logger
     * @param metadata true for zero-arg (metadata) methods
     * @param format   the slf4j message format
     * @param args     the format arguments
     */
    private static void record(Logger log, boolean metadata, String format, Object... args) {
        if (metadata) {
            log.trace(format, args);
        } else {
            log.debug(format, args);
        }
    }

    /**
     * Reflective forward that unwraps the InvocationTargetException — the
     * caller must see the delegate's ORIGINAL exception object.
     *
     * @param method   the invoked method
     * @param delegate the real implementation
     * @param args     the call arguments; may be null
     * @return the delegate's result
     * @throws Throwable the delegate's original exception
     */
    private static Object forward(Method method, Object delegate, Object[] args) throws Throwable {
        try {
            return method.invoke(delegate, args);
        } catch (InvocationTargetException wrapped) {
            throw wrapped.getCause();
        }
    }

    /**
     * The abbreviated argument list for the entry record.
     *
     * @param args the call arguments; may be null
     * @return each argument stringified and clipped to {@link #ARG_PREVIEW_CHARS}, comma-joined
     */
    private static String renderArgs(Object[] args) {
        if (args == null || args.length == 0) {
            return "";
        }
        return Arrays.stream(args)
                .map(arg -> {
                    String text = String.valueOf(arg);
                    return text.length() <= ARG_PREVIEW_CHARS
                            ? text
                            : text.substring(0, ARG_PREVIEW_CHARS) + "…";
                })
                .collect(Collectors.joining(", "));
    }
}
