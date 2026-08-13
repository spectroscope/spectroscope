package dev.spectroscope.core.net;

import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * Where a browser-class tool may go (card 199, criterion 5).
 *
 * <p>The tools that reach the network — {@code web_fetch}, {@code browse_page},
 * and the browser family cards 201 and 205 are waiting on — take their address
 * from model output, and the model reads whatever page it was last shown. On
 * this machine that reach is not theoretical: the board answers on 8746, ollama
 * on 11434, and a whole tailnet sits one hop away. A prompt-injected page must
 * not be able to send the agent there.
 *
 * <p>So the private world is refused by default:
 *
 * <ul>
 *   <li>every scheme but http and https, {@code file://} named explicitly;</li>
 *   <li>RFC-1918 — 10/8, 172.16/12, 192.168/16;</li>
 *   <li>100.64/10, the CGNAT range Tailscale hands out;</li>
 *   <li>link-local 169.254/16 (which is where a cloud metadata service lives)
 *       and IPv6 fe80::/10;</li>
 *   <li>IPv6 unique-local fc00::/7, and the unspecified address;</li>
 *   <li>loopback — unless the operator opted in for the local verify loop, which
 *       is the one legitimate reason to point this product at itself.</li>
 * </ul>
 *
 * <p><b>A name is judged by where it points.</b> {@code localtest.me} looks
 * public and resolves to 127.0.0.1, and a DNS record an attacker controls can
 * say anything. So every host is resolved and EVERY answer is checked; one
 * private answer refuses the call. The one exception is a name DNS cannot
 * resolve at all: the fence does not invent an answer, and a request that cannot
 * resolve cannot connect either, so it is left to fail on its own rather than
 * making this class a second DNS dependency.
 *
 * <p><b>A refusal names the address and the rule and carries nothing else.</b>
 * Not the path, not the query string, not the userinfo — a URL the model
 * assembled may carry a token in any of the three, and a refusal sentence goes
 * back to the model and into the transcript.
 */
public final class NetFence {

    /** How a host name becomes addresses. A seam: the suite answers from a table. */
    @FunctionalInterface
    public interface Resolver {
        /**
         * Every address a host name points at.
         *
         * @param host the host name, without brackets
         * @return the resolved addresses, never empty
         * @throws UnknownHostException when the name does not resolve
         */
        List<InetAddress> resolve(String host) throws UnknownHostException;
    }

    /** The production resolver — the platform's own. */
    public static final Resolver SYSTEM_DNS =
            host -> Arrays.asList(InetAddress.getAllByName(host));

    /**
     * One refusal, with nothing in it that was not already public.
     *
     * @param address  the host and port that were refused, never a path or a query
     * @param rule     the rule's stable name: file-url, non-http-scheme, rfc1918,
     *                 cgnat-tailnet, link-local, unique-local, loopback,
     *                 unspecified or unparsable
     * @param sentence the model-facing and operator-facing sentence
     */
    public record Refusal(String address, String rule, String sentence) {}

    private final boolean allowLocalhost;
    private final Resolver resolver;

    /**
     * @param allowLocalhost the explicit opt-in for the local verify loop; loopback
     *                       stays refused without it, and the opt-in never widens
     *                       to the LAN, the tailnet or a file URL
     * @param resolver       how host names become addresses
     */
    public NetFence(boolean allowLocalhost, Resolver resolver) {
        this.allowLocalhost = allowLocalhost;
        this.resolver = resolver;
    }

    /**
     * The fence with the platform resolver.
     *
     * @param allowLocalhost the local-verify-loop opt-in
     * @return a fence resolving through system DNS
     */
    public static NetFence withSystemDns(boolean allowLocalhost) {
        return new NetFence(allowLocalhost, SYSTEM_DNS);
    }

    /**
     * Whether this URL is refused.
     *
     * @param url the address a browser-class tool was asked to reach
     * @return the refusal, or null when the address passes
     */
    public Refusal refuse(String url) {
        if (url == null || url.isBlank()) {
            return new Refusal("(no address)", "unparsable",
                    sentence("(no address)", "unparsable", "no address was given"));
        }
        String trimmed = url.strip();
        String lower = trimmed.toLowerCase(Locale.ROOT);
        if (lower.startsWith("file:")) {
            return new Refusal("a file:// URL", "file-url",
                    sentence("a file:// URL", "file-url",
                            "this tool reaches the network, not the local disk"));
        }
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            String scheme = schemeOf(trimmed);
            String what = "the scheme \"" + scheme + "\"";
            return new Refusal(what, "non-http-scheme",
                    sentence(what, "non-http-scheme", "only http and https are reachable"));
        }
        URI uri;
        try {
            uri = new URI(trimmed);
        } catch (URISyntaxException notAUri) {
            return new Refusal("(unreadable)", "unparsable",
                    sentence("(unreadable)", "unparsable", "it is not a readable http address"));
        }
        String host = uri.getHost();
        if (host == null || host.isBlank()) {
            return new Refusal("(unreadable)", "unparsable",
                    sentence("(unreadable)", "unparsable", "it is not a readable http address"));
        }
        String bare = host.startsWith("[") && host.endsWith("]")
                ? host.substring(1, host.length() - 1)
                : host;
        String where = uri.getPort() >= 0 ? bare + ":" + uri.getPort() : bare;

        if (!allowLocalhost && isLoopbackName(bare)) {
            return refusalFor(where, "loopback");
        }
        List<InetAddress> addresses;
        if (isIpLiteral(bare)) {
            // A literal is already an answer; asking a resolver about it would only
            // put a seam (and in the suite, a table) between the fence and a fact.
            try {
                addresses = List.of(InetAddress.getByName(bare));
            } catch (UnknownHostException notAnAddress) {
                return new Refusal(where, "unparsable",
                        sentence(where, "unparsable", "it is not a readable http address"));
            }
        } else {
            try {
                addresses = resolver.resolve(bare);
            } catch (UnknownHostException | RuntimeException cannotSay) {
                return null;   // the fetch will fail on its own; the fence invents nothing
            }
        }
        if (addresses == null || addresses.isEmpty()) {
            return null;
        }
        for (InetAddress address : addresses) {
            String rule = ruleFor(address);
            if (rule != null) {
                return refusalFor(where, rule);
            }
        }
        return null;
    }

    /** An IPv4 address in any spelling a parser might accept — dotted decimal,
     *  a bare integer, octal with a leading zero, hex with 0x. All of them are
     *  ways to write 127.0.0.1 without typing it. */
    private static final java.util.regex.Pattern IPV4_ISH = java.util.regex.Pattern
            .compile("(0[xX][0-9a-fA-F]+|\\d+)(\\.(0[xX][0-9a-fA-F]+|\\d+)){0,3}");

    /** Whether the host is already an address rather than a name. An address is
     *  judged directly; only a NAME goes to the resolver seam. The check is
     *  deliberately wider than "dotted quad": {@code 2130706433},
     *  {@code 0177.0.0.1} and {@code 0x7f.1} are all ways of writing loopback
     *  without typing it, and a spelling that reaches this branch and then fails
     *  to parse is refused as unreadable rather than waved through as a name. */
    private static boolean isIpLiteral(String host) {
        return !host.isEmpty()
                && (host.indexOf(':') >= 0 || IPV4_ISH.matcher(host).matches());
    }

    /** "localhost" and anything under it, decided before DNS so the opt-in reads
     *  the way an operator expects even on a machine with a hostile resolver. */
    private static boolean isLoopbackName(String host) {
        String lower = host.toLowerCase(Locale.ROOT);
        return "localhost".equals(lower) || lower.endsWith(".localhost");
    }

    /** The rule one resolved address breaks, or null when it breaks none. */
    private String ruleFor(InetAddress address) {
        if (address.isAnyLocalAddress()) {
            return "unspecified";
        }
        if (address.isLoopbackAddress()) {
            return allowLocalhost ? null : "loopback";
        }
        if (address.isLinkLocalAddress()) {
            return "link-local";
        }
        if (address instanceof Inet4Address v4) {
            byte[] octets = v4.getAddress();
            int first = octets[0] & 0xFF;
            int second = octets[1] & 0xFF;
            if (first == 10
                    || (first == 172 && second >= 16 && second <= 31)
                    || (first == 192 && second == 168)) {
                return "rfc1918";
            }
            // 100.64.0.0/10 — the shared address space RFC 6598 reserves and
            // Tailscale hands out. The mask is on the top 10 bits, so the second
            // octet runs 64..127 and nothing outside it belongs to the range.
            if (first == 100 && second >= 64 && second <= 127) {
                return "cgnat-tailnet";
            }
            return null;
        }
        if (address instanceof Inet6Address v6) {
            int first = v6.getAddress()[0] & 0xFF;
            if ((first & 0xFE) == 0xFC) {   // fc00::/7, unique local
                return "unique-local";
            }
            return null;
        }
        return null;
    }

    /** The sentence per rule — WHAT was refused and WHY, and nothing else. */
    private static Refusal refusalFor(String where, String rule) {
        String why = switch (rule) {
            case "loopback" -> "it is this machine, and the local verify loop is not opted in "
                    + "(set allowLocalhost in the settings to reach it on purpose)";
            case "rfc1918" -> "it is a private network address, RFC 1918";
            case "cgnat-tailnet" -> "it is in 100.64/10, the range a tailnet uses";
            case "link-local" -> "it is a link-local address";
            case "unique-local" -> "it is a unique-local address";
            case "unspecified" -> "it is the unspecified address";
            default -> "the net fence refuses it";
        };
        return new Refusal(where, rule, sentence(where, rule, why));
    }

    /** The one shape every refusal takes: what, why, and the rule's own name so a
     *  reader can find the line in this file that produced it. Nothing else goes
     *  in — no path, no query, no userinfo, no header, no key material. */
    private static String sentence(String what, String rule, String why) {
        return "refused " + what + ": " + why + " (rule: " + rule + ").";
    }

    /** The scheme as written, bounded and stripped of anything that is not one. */
    private static String schemeOf(String url) {
        int colon = url.indexOf(':');
        String head = colon < 0 ? url : url.substring(0, colon);
        StringBuilder clean = new StringBuilder();
        for (int i = 0; i < head.length() && i < 20; i++) {
            char c = head.charAt(i);
            if (Character.isLetterOrDigit(c) || c == '+' || c == '-' || c == '.') {
                clean.append(c);
            } else {
                break;
            }
        }
        return clean.isEmpty() ? "(none)" : clean.toString();
    }
}
