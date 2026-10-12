package dev.spectroscope.core.peer;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;

/**
 * Names peers address a session by (card 502 criterion 12, concept table row
 * Names): derived from the folder, the session title wins, unique among live
 * sessions with a deterministic loser. A title, and any name read from another
 * process's registry row, keeps only letters, digits, dots, underscores and
 * hyphens, so a name reads as a name in the attribution block.
 */
public final class PeerNames {

    private static final List<String> ADJECTIVES = List.of("amber", "brisk", "calm", "deft", "eager", "fair",
            "glad", "hardy", "keen", "lucid", "mellow", "nimble", "plain", "quiet", "ready", "steady");
    private static final List<String> NOUNS = List.of("otter", "heron", "maple", "comet", "harbor", "falcon",
            "willow", "lantern", "meadow", "pebble", "summit", "badger", "cedar", "delta", "ember", "fjord");

    /**
     * A name and where it came from.
     *
     * @param name   the name
     * @param source {@code derived} or {@code title}
     */
    public record Named(String name, String source) {
    }

    /**
     * One live session's claim on a name.
     *
     * @param startedAt the claiming process's registration time
     * @param procStart the claiming process's start instant
     * @param pid       the claiming process
     * @param sessionId the session
     * @param name      the name it claims
     */
    public record Claim(long startedAt, String procStart, long pid, String sessionId, String name) {
    }

    private static final Comparator<Claim> ORDER = Comparator.comparingLong(Claim::startedAt)
            .thenComparing(Claim::procStart, Comparator.nullsLast(Comparator.naturalOrder()))
            .thenComparingLong(Claim::pid)
            .thenComparing(Claim::sessionId);

    private PeerNames() {
    }

    /**
     * @param cwd       the session's folder
     * @param sessionId the session id, which picks the suffix
     * @return {@code <folder basename>-<2 hex>}
     */
    public static String derive(String cwd, String sessionId) {
        String base = "session";
        if (cwd != null && !cwd.isBlank()) {
            Path name = Path.of(cwd).getFileName();
            if (name != null) {
                base = name.toString().replaceAll("[^A-Za-z0-9._-]", "-");
            }
        }
        return base + "-" + hex(sessionId).substring(0, PeerLimits.NAME_SUFFIX_HEX);
    }

    /**
     * @param cwd       the folder
     * @param sessionId the session
     * @param title     the session title of card 445, or null
     * @return the title when one is set, else the derived name
     */
    public static Named name(String cwd, String sessionId, String title) {
        String cleaned = clean(title);
        if (!cleaned.isEmpty()) {
            return new Named(cleaned, "title");
        }
        return new Named(derive(cwd, sessionId), "derived");
    }

    /**
     * @param name a name from a title or a registry row
     * @return the name reduced to letters, digits, dots, underscores and hyphens
     */
    public static String clean(String name) {
        if (name == null) {
            return "";
        }
        return Normalizer.normalize(name, Normalizer.Form.NFKC)
                .replaceAll("[^\\p{L}\\p{M}\\p{N}._-]+", "-")
                .replaceAll("^-+|-+$", "");
    }

    /**
     * Card 503: a name another session wrote, as this process shows and
     * addresses it: cleaned as {@link #clean} cleans and cut at
     * {@link PeerLimits#LISTING_LINE_CAP} characters, so a forged record
     * cannot fill a listing or a notice with one name.
     *
     * @param name a name from a registry row
     * @return the name to show
     */
    public static String shown(String name) {
        return cap(clean(name));
    }

    /**
     * @param name a name
     * @return the name cut at {@link PeerLimits#LISTING_LINE_CAP} characters, never inside a pair
     */
    public static String cap(String name) {
        if (name == null || name.length() <= PeerLimits.LISTING_LINE_CAP) {
            return name;
        }
        return PeerNotices.cut(name, PeerLimits.LISTING_LINE_CAP);
    }

    /**
     * @param a a name
     * @param b a name
     * @return true when they match after NFKC and lower case
     */
    public static boolean same(String a, String b) {
        return a != null && b != null && key(a).equals(key(b));
    }

    /**
     * @param name a name
     * @return its matching key
     */
    public static String key(String name) {
        return Normalizer.normalize(name, Normalizer.Form.NFKC).strip().toLowerCase(Locale.ROOT);
    }

    /**
     * Whether a claim must yield: another live claim on the same name comes
     * first by {@code startedAt}, then {@code procStart}, then pid.
     *
     * @param claim the claim
     * @param all   every live claim, the claim among them
     * @return true when the claim yields
     */
    public static boolean yields(Claim claim, List<Claim> all) {
        return all.stream()
                .filter(other -> !other.sessionId().equals(claim.sessionId()) || other.pid() != claim.pid())
                .filter(other -> same(other.name(), claim.name()))
                .anyMatch(other -> ORDER.compare(other, claim) < 0);
    }

    /**
     * @param base      the contested name
     * @param sessionId the yielding session
     * @return {@code <base>-<adjective>-<noun>}, stable for the session
     */
    public static String loserName(String base, String sessionId) {
        String hex = hex(sessionId);
        int a = Integer.parseInt(hex.substring(0, 2), 16) % ADJECTIVES.size();
        int n = Integer.parseInt(hex.substring(2, 4), 16) % NOUNS.size();
        return base + "-" + ADJECTIVES.get(a) + "-" + NOUNS.get(n);
    }

    /**
     * @param sessionId a session id
     * @return 24 hex characters that stand for the session in a hop chain
     */
    public static String hop(String sessionId) {
        return hex(sessionId).substring(0, 24);
    }

    /**
     * The short ref a listing prints after a name, so two rows of the same
     * name can be told apart (card 503).
     *
     * @param kind {@code session} for a peer session, {@code agent} for an agent of a run
     * @param id   the session id or the agent id
     * @return the first {@link PeerLimits#REF_HEX} hex characters of a hash of {@code <kind>:<id>}
     */
    public static String ref(String kind, String id) {
        return hex(kind + ":" + id).substring(0, PeerLimits.REF_HEX);
    }

    private static String hex(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(String.valueOf(text).getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
