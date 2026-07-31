package dev.spectroscope.cli;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The parsed trigger flags of a standing node (card 72). Parsing IS the first
 * security fence: --listen accepts a bare port only (a host cannot even be
 * expressed — the bind is loopback by construction in {@link HttpTrigger}),
 * and --watch must canonicalize to an existing directory before any watcher
 * thread exists. Both refuse with the reason, at flag time, before config,
 * network or provider are touched.
 *
 * @param watchRoot  the canonical (toRealPath) watch directory, or null
 * @param listenPort the HTTP trigger port, or null
 * @param everyMs    the timer period in millis, or null
 * @param everyLabel the operator's own duration spelling ("5m") for card and
 *                   prompt — the parsed millis would read like a machine's
 * @param token      the per-boot bearer token, minted only when listenPort is
 *                   set; printed once to stderr, never on any wire or event
 */
record TriggerSpec(Path watchRoot, Integer listenPort, Long everyMs, String everyLabel,
                   String token) {

    private static final Pattern EVERY = Pattern.compile("(\\d+)(ms|s|m|h)");
    private static final SecureRandom RANDOM = new SecureRandom();

    /**
     * Builds the spec from the raw flag values; null flags stay absent.
     *
     * @param watch  the --watch value, or null
     * @param listen the --listen value, or null
     * @param every  the --every value, or null
     * @return the validated spec
     * @throws IllegalArgumentException with the operator-facing reason
     */
    static TriggerSpec parse(String watch, String listen, String every) {
        Path watchRoot = watch != null ? canonicalWatchRoot(watch) : null;
        Integer listenPort = listen != null ? parseListenPort(listen) : null;
        Long everyMs = every != null ? parseEveryMs(every) : null;
        String token = listenPort != null ? mintToken() : null;
        return new TriggerSpec(watchRoot, listenPort, everyMs, every, token);
    }

    /** @return true when at least one trigger flag was given */
    boolean any() {
        return watchRoot != null || listenPort != null || everyMs != null;
    }

    /** @return the combined identity for card and boot line, e.g.
     *          "watch:/drop + listen:127.0.0.1:8300 + every:5m" */
    String describe() {
        List<String> parts = new ArrayList<>();
        if (watchRoot != null) {
            parts.add("watch:" + watchRoot);
        }
        if (listenPort != null) {
            parts.add("listen:127.0.0.1:" + listenPort);
        }
        if (everyMs != null) {
            parts.add("every:" + everyLabel);
        }
        return String.join(" + ", parts);
    }

    /**
     * The watch-root fence: exists, is a directory, canonicalized ONCE here —
     * event paths are later relativized against exactly this root, so a
     * symlinked flag value cannot drift from what the watcher actually sees.
     *
     * @param dir the --watch flag value
     * @return the canonical root
     */
    static Path canonicalWatchRoot(String dir) {
        Path path = Path.of(dir);
        if (!Files.exists(path)) {
            throw new IllegalArgumentException("--watch dir does not exist: " + dir);
        }
        if (!Files.isDirectory(path)) {
            throw new IllegalArgumentException("--watch must name a directory, got: " + dir);
        }
        try {
            return path.toRealPath();
        } catch (IOException unreadable) {
            throw new IllegalArgumentException("--watch dir is not resolvable: " + dir
                    + " (" + unreadable.getMessage() + ")");
        }
    }

    /**
     * The listen fence's flag half: digits only. "0.0.0.0:8300" must fail
     * HERE, with the reason — not bind differently than the operator thought.
     *
     * @param value the --listen flag value
     * @return the port, 1-65535
     */
    static int parseListenPort(String value) {
        if (!value.matches("\\d+")) {
            throw new IllegalArgumentException("--listen takes a bare port only (the bind is"
                    + " always 127.0.0.1 — a host cannot be chosen), got \"" + value + "\"");
        }
        int port;
        try {
            port = Integer.parseInt(value);
        } catch (NumberFormatException tooLong) {
            throw new IllegalArgumentException("--listen port out of range: " + value);
        }
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("--listen port out of range: " + port);
        }
        return port;
    }

    /**
     * The timer grammar: {@code <n>(ms|s|m|h)}, at least one second — a
     * sub-second period is a spin, not an automation.
     *
     * @param value the --every flag value
     * @return the period in millis
     */
    static long parseEveryMs(String value) {
        Matcher matcher = EVERY.matcher(value);
        if (!matcher.matches()) {
            throw new IllegalArgumentException(
                    "--every must be <n>ms|s|m|h (e.g. 30s, 5m), got \"" + value + "\"");
        }
        long amount = Long.parseLong(matcher.group(1));
        long ms = switch (matcher.group(2)) {
            case "ms" -> amount;
            case "s" -> amount * 1_000;
            case "m" -> amount * 60_000;
            default -> amount * 3_600_000;
        };
        if (ms < 1_000) {
            throw new IllegalArgumentException("--every must be at least 1s, got \"" + value + "\"");
        }
        return ms;
    }

    /** 16 random bytes as 32 hex chars — compared constant-time in the trigger. */
    private static String mintToken() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }
}
