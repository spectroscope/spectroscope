package dev.spectroscope.core.peer;

import dev.spectroscope.core.config.governing.Governs;

/**
 * The numbers of agent messaging (card 502). Each one is a governed row in
 * {@code numbers.json}; the guard numbers are reader 01's dump values of the
 * Claude Code ingress guard, the rest are the concept's.
 */
public final class PeerLimits {

    private PeerLimits() {
    }

    /** Tokens in the per sender bucket at the inbox, and in the sender's own pacer. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int BUCKET_CAPACITY = 30;

    /** Tokens the bucket regains per second. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.RATIO)
    public static final double REFILL_PER_SECOND = 0.5;

    /** How long the same words from the same sender count as a duplicate. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long DUPLICATE_WINDOW_MS = 30_000L;

    /** How often a hop chain may already name this session before the message is a loop. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int SELF_HOP_LIMIT = 10;

    /** The longest hop chain a message may carry; one more is a runaway. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int CHAIN_LENGTH = 28;

    /** Undelivered messages one session holds before the next is dropped. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int QUEUE_CAP = 64;

    /** Hop ids the attribution block shows at most. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int HOP_LIST_CAP = 32;

    /** Senders the guard keeps a bucket for; the oldest is forgotten past this. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int TRACKED_SENDERS = 256;

    /** How long a listing waits for one socket to accept a connection. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final int PROBE_TIMEOUT_MS = 250;

    /** A registry record larger than this is skipped unread. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.BYTES)
    public static final int RECORD_MAX_BYTES = 262_144;

    /** The longest frame line; a longer line closes the connection. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int LINE_CAP_CHARS = 1_048_576;

    /** Connect and write time a sender allows one delivery. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final int SEND_TIMEOUT_MS = 5_000;

    /**
     * How long a sender waits before it connects again when a live process
     * refused the connect, as a full listen backlog does; the send timeout
     * ends the retries.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final int CONNECT_RETRY_MS = 50;

    /** How long an endpoint waits for the auth frame of a new connection before it closes it. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final int AUTH_TIMEOUT_MS = 5_000;

    /**
     * How many connections may wait to authenticate at one endpoint; a newer
     * connection displaces the oldest waiting one.
     */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int UNAUTHENTICATED_CAP = 16;

    /** How long a held message waits for Deliver or Decline before it expires. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    public static final int HELD_EXPIRY_SECONDS = 600;

    /** How often a server lists the registry for its roster and for dead records. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final int ROSTER_POLL_MS = 5_000;

    /** Hex characters of the suffix of a derived session name. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int NAME_SUFFIX_HEX = 2;

    /** The protocol version a record states. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int PROTOCOL = 1;
    /** The longest summary a message carries; a longer one is cut, not refused (card 503). */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int SUMMARY_CAP = 200;

    /** How long an idle subscription waits for its one notice before it expires (card 503). */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final long IDLE_LIFETIME_MS = 43_200_000L;

    /** Idle subscriptions one session may hold open at once (card 503). */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int IDLE_OUTSTANDING_CAP = 32;

    /** How long a session stays idle before its subscribers hear it (card 503). */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.MILLISECONDS)
    public static final int IDLE_DEBOUNCE_MS = 750;

    /** Characters of the watched session's last text an idle notice quotes at most (card 503). */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int IDLE_TEXT_CAP = 100;

    /** Rows one section of a listing shows before it says how many more there are (card 503). */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.COUNT)
    public static final int LISTING_ROWS_CAP = 100;

    /** Characters of a session's folder a listing prints at most, its end kept (card 503 fix round). */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int LISTING_FOLDER_CAP = 120;

    /** Characters of a status line, a face or a status a listing prints at most (card 503 fix round). */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int LISTING_LINE_CAP = 100;

    /** Hex characters of the ref a listing prints after a name (card 503). */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int REF_HEX = 6;

    /** The shortest command, path or file name the relay rule matches against a peer's words (card 503). */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    public static final int RELAY_MARK_MIN_CHARS = 3;
}
