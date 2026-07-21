package dev.spectroscope.orchestrator;

import java.util.Map;
import java.util.Objects;

/**
 * A parsed, validated fleet-hub address ({@code host:port}). Strict on purpose:
 * a fleet-address typo must fail LOUDLY at construction, not as a silent
 * connect-retry loop. This is the parser for {@code SPECTRO_HUB}; its rules are
 * kept identical to the CLI's {@code --hub} parser ({@code NodeCommand.parseHub}).
 * Consolidating the two onto this one parser is a fast-follow (the CLI messages
 * carry a {@code --hub} prefix this env-side parser deliberately does not).
 *
 * @param host an IPv4 literal or hostname (IPv6 literals are not supported yet)
 * @param port a TCP port in 1..65535
 */
public record HubAddress(String host, int port) {

    public HubAddress {
        Objects.requireNonNull(host, "host");
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("hub port out of range: " + port);
        }
    }

    /**
     * The hub from {@code SPECTRO_HUB}, or {@code null} when unset/blank.
     *
     * @param env the environment to read (injectable for tests)
     * @return the parsed address, or null when the var is absent or blank
     * @throws IllegalArgumentException when the var is present but malformed
     */
    public static HubAddress fromEnv(Map<String, String> env) {
        String raw = env.get("SPECTRO_HUB");
        return raw == null || raw.isBlank() ? null : parse(raw);
    }

    /**
     * Strict {@code host:port} — mirrors {@code NodeCommand.parseHub}: last-colon
     * split, IPv6 literals refused loudly, numeric port in range.
     *
     * @param address the raw {@code host:port} string
     * @return the validated address
     * @throws IllegalArgumentException on any malformed input
     */
    public static HubAddress parse(String address) {
        int colon = address.lastIndexOf(':');
        if (colon <= 0 || colon == address.length() - 1) {
            throw new IllegalArgumentException("hub must be host:port, got \"" + address + "\"");
        }
        String host = address.substring(0, colon);
        if (host.indexOf(':') >= 0 || host.indexOf('[') >= 0 || host.indexOf(']') >= 0) {
            throw new IllegalArgumentException(
                    "hub must be an IPv4/hostname host:port (IPv6 literals are not"
                            + " supported yet), got \"" + address + "\"");
        }
        int port;
        try {
            port = Integer.parseInt(address.substring(colon + 1));
        } catch (NumberFormatException notANumber) {
            throw new IllegalArgumentException("hub port must be a number, got \"" + address + "\"");
        }
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("hub port out of range: " + port);
        }
        return new HubAddress(host, port);
    }
}
