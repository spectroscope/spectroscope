package dev.spectroscope.core.browser.headless;

import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.net.NetFence;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;

/**
 * The web face's navigation gate — where the desktop's {@code browserFence.ts}
 * request hook stands, for the headless engine (card 226).
 *
 * <p>It is deliberately NOT a third policy. The judge is {@link NetFence}
 * itself, the same class the entry check runs, built fresh per judgment so the
 * {@code allowLocalhost} opt-in saved mid-session reaches the very next hop.
 * What this class adds is only what the hook position needs:
 *
 * <ul>
 *   <li><b>a short resolver cache</b> — the gate judges every document hop, and
 *       a redirect chain across four hosts must not pay a lookup per hop per
 *       navigation. The cost is stated, not hidden: for up to
 *       {@link #LOOKUP_TTL_MS} the fence judges the answer it saw, not the
 *       answer Chrome's own dial will get. Neither half of any fence in this
 *       product is the one that dials, so a record that changes underneath both
 *       (DNS rebinding) stays outside what either can promise —
 *       {@code docs/BROWSER.md} says so where the operator reads it.</li>
 *   <li><b>the hook's vantage point</b> — the URL handed in comes out of
 *       Chrome's network stack via {@code Fetch.requestPaused},
 *       WHATWG-normalised. The old IPv4 spellings the divergence register lists
 *       ({@code 0177.0.0.1}, {@code 0x7f000001}) arrive already rewritten to
 *       the address Chrome dials, so judging them with {@link InetAddress} is
 *       judging the truth rather than the spelling.</li>
 * </ul>
 *
 * <p>A failed lookup is never cached: the fence invents no answer for a name
 * DNS cannot resolve — the request is left to fail on its own — and the next
 * judgment asks again, exactly like the desktop hook's {@code cachedLookup}.
 */
public final class HeadlessFence {

    /** How long one resolved answer is reused — the desktop hook's own window. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long LOOKUP_TTL_MS = 30_000;

    private final BooleanSupplier allowLocalhost;
    private final NetFence.Resolver caching;

    /** One remembered answer: when it was asked, and what came back. */
    private record Answer(long at, List<InetAddress> addresses) {
    }

    private final Map<String, Answer> seen = new ConcurrentHashMap<>();

    /**
     * The production gate: system DNS, real clock, the hook's own window.
     *
     * @param allowLocalhost card 199's local-verify-loop opt-in, read per judgment
     */
    public HeadlessFence(BooleanSupplier allowLocalhost) {
        this(allowLocalhost, NetFence.SYSTEM_DNS, System::currentTimeMillis, LOOKUP_TTL_MS);
    }

    /**
     * The seam form — the suite drives the resolver from the vector table and
     * the clock by hand.
     *
     * @param allowLocalhost the opt-in, read per judgment
     * @param dns            how a host name becomes addresses
     * @param clock          the time source the cache window is measured on
     * @param ttlMs          how long one resolved answer is reused
     */
    public HeadlessFence(BooleanSupplier allowLocalhost, NetFence.Resolver dns,
            LongSupplier clock, long ttlMs) {
        this.allowLocalhost = allowLocalhost;
        this.caching = host -> {
            Answer hit = seen.get(host);
            long now = clock.getAsLong();
            if (hit != null && now - hit.at() < ttlMs) {
                return hit.addresses();
            }
            List<InetAddress> answers;
            try {
                answers = dns.resolve(host);
            } catch (UnknownHostException | RuntimeException failed) {
                // A failure is not an answer and must not be remembered as one
                // for the whole window.
                seen.remove(host);
                throw failed;
            }
            seen.put(host, new Answer(now, answers));
            return answers;
        };
    }

    /**
     * Whether this hop is refused. {@code null} means allowed.
     *
     * @param url the address Chrome is about to dial, as {@code Fetch.requestPaused}
     *            reports it — already normalised by the browser's own parser
     * @return the refusal, or null when the hop passes
     */
    public NetFence.Refusal judge(String url) {
        return new NetFence(allowLocalhost.getAsBoolean(), caching).refuse(url);
    }
}
