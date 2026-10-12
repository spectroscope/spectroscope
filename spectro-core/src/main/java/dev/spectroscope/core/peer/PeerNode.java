package dev.spectroscope.core.peer;

import com.fasterxml.jackson.databind.JsonNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * One process's part in agent messaging (card 502): its record in the
 * registry, its inbox socket, and the delivery of every arriving message to
 * the session it names.
 *
 * <p>Delivery follows concept decisions 4 and 5. A run that is up takes the
 * message at its next safe point and the sender hears {@code delivered} once
 * the loop absorbed it. An idle attended session of the sender's permission
 * class starts a run with the message as its input. An idle session of another
 * class holds it until {@link #decide} or the expiry. An unattended face, or a
 * face that is not accepting, refuses. A guard that trips drops it. Every
 * outcome goes back to the sender as a {@code peer_message_status} frame with
 * the {@code msg_id} echoed, and into both sessions' {@code .messages.jsonl}.
 * Log lines carry the {@code msg_id}, the pid and the status, never a body.</p>
 */
public final class PeerNode implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(PeerNode.class);
    private static final String AFTER_HOLD = "after_hold";

    /**
     * What one send did.
     *
     * @param sent  true when the frame was written to the receiving socket
     * @param msgId the message id, also when not sent
     * @param error the failure class, or null
     * @param text  the failure text for the model, or null
     */
    public record SendResult(boolean sent, String msgId, PeerClient.Error error, String text) {
    }

    private record Held(PeerEnvelope envelope, String sessionId, ScheduledFuture<?> expiry) {
    }

    private record Subscriber(String msgId, long pid, String sessionId) {
    }

    /**
     * What this process sent and still expects an answer to: the sending
     * session, the pid it went to, the name used, and whether it was a
     * message (answered by status frames) or a subscription (answered by one
     * idle notice). A status or notice counts only from that pid, for an id in
     * this map, and lands in the session recorded here.
     */
    private record Sent(String sessionId, long pid, String name, boolean message) {
    }

    private final LiveRegistry registry;
    private final ProcessIdentity self;
    private final String version;
    private final PeerHost host;
    private final MessagesSidecar sidecar;
    private final Duration heldExpiry;
    private final Duration healEvery;
    private final java.util.concurrent.atomic.AtomicLong recordWrites = new java.util.concurrent.atomic.AtomicLong();
    private final PeerClient client;
    private final SenderPacer pacer = new SenderPacer(System::currentTimeMillis);
    private final Map<String, IngressGuard> guards = new ConcurrentHashMap<>();
    private final Map<String, Held> held = new ConcurrentHashMap<>();
    private final Set<String> releasedAfterHold = ConcurrentHashMap.newKeySet();
    private final Set<PeerInbox> hooked = Collections.newSetFromMap(Collections.synchronizedMap(new IdentityHashMap<>()));
    private final Map<String, Set<Long>> correspondents = new ConcurrentHashMap<>();
    private final Map<String, String> names = new ConcurrentHashMap<>();
    private final Map<String, Sent> sent = new ConcurrentHashMap<>();
    private final Set<String> heldAnswered = ConcurrentHashMap.newKeySet();
    private final Map<String, List<Subscriber>> subscribers = new ConcurrentHashMap<>();
    private final Map<String, Boolean> wasRunning = new ConcurrentHashMap<>();
    private final ArrayBlockingQueue<Boolean> pending = new ArrayBlockingQueue<>(1);
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "spectro-peer-timers");
        thread.setDaemon(true);
        return thread;
    });
    /** Card 503: the expiry of every subscription this process made, by msg_id. */
    private final Map<String, ScheduledFuture<?>> subscriptionExpiry = new ConcurrentHashMap<>();
    /** Card 503: the pending idle notice of every watched session, by session id. */
    private final Map<String, ScheduledFuture<?>> idleDebounces = new ConcurrentHashMap<>();
    private volatile Duration idleLifetime = Duration.ofMillis(PeerLimits.IDLE_LIFETIME_MS);
    private volatile Duration idleDebounce = Duration.ofMillis(PeerLimits.IDLE_DEBOUNCE_MS);
    private volatile List<LiveRecord> roster = List.of();
    private volatile PeerEndpoint endpoint;
    private volatile Thread writer;
    private volatile long startedAt;
    private volatile boolean closed;

    /**
     * @param registry   the registry, usually under {@code ~/.spectro/live}
     * @param self       this process
     * @param version    the product version the record states
     * @param host       the face
     * @param sidecar    where {@code .messages.jsonl} lines go
     * @param heldExpiry how long a held message waits for a decision
     */
    public PeerNode(LiveRegistry registry, ProcessIdentity self, String version, PeerHost host,
                    MessagesSidecar sidecar, Duration heldExpiry) {
        this(registry, self, version, host, sidecar, heldExpiry, Duration.ofMillis(PeerLimits.ROSTER_POLL_MS));
    }

    /**
     * @param registry   the registry
     * @param self       this process
     * @param version    the product version
     * @param host       the face
     * @param sidecar    where {@code .messages.jsonl} lines go
     * @param heldExpiry how long a held message waits for a decision
     * @param healEvery  how often the node checks that its own record is still in the registry
     */
    PeerNode(LiveRegistry registry, ProcessIdentity self, String version, PeerHost host,
             MessagesSidecar sidecar, Duration heldExpiry, Duration healEvery) {
        this.healEvery = healEvery;
        this.registry = registry;
        this.self = self;
        this.version = version;
        this.host = host;
        this.sidecar = sidecar;
        this.heldExpiry = heldExpiry;
        this.client = new PeerClient(registry, self);
    }

    /**
     * The production wiring for one face: this process, the home's registry
     * and sidecars, and the governed expiry.
     *
     * @param host    the face
     * @param version the product version
     * @return the node, not yet started
     */
    public static PeerNode forThisProcess(PeerHost host, String version) {
        return new PeerNode(new LiveRegistry(LiveRegistry.defaultDir()), ProcessIdentity.current(), version, host,
                new MessagesSidecar(MessagesSidecar.defaultDir()),
                Duration.ofSeconds(PeerLimits.HELD_EXPIRY_SECONDS));
    }

    /** @return the product version from the jar manifest, or {@code dev} in a build tree */
    public static String productVersion() {
        String version = PeerNode.class.getPackage().getImplementationVersion();
        return version == null || version.isBlank() ? "dev" : version;
    }

    /**
     * Binds the socket, writes the record and starts the writer.
     *
     * @throws IOException when the socket cannot be bound
     */
    public void start() throws IOException {
        startedAt = System.currentTimeMillis();
        PeerEndpoint bound = new PeerEndpoint(registry, self, this::onFrame);
        bound.start();
        endpoint = bound;
        flush();
        writer = Thread.ofVirtual().name("spectro-peer-record").start(this::writeLoop);
        timers.scheduleWithFixedDelay(this::heal, healEvery.toMillis(), healEvery.toMillis(), TimeUnit.MILLISECONDS);
        log.info("peer registry record {} written, face {}", self.pid(), host.face());
    }

    /** A session's status changed: the record is rewritten through a depth one queue. */
    public void changed() {
        pending.offer(Boolean.TRUE);
    }

    /**
     * Writes the record again when it is gone from the registry or names
     * another socket or start: a reader unlinks the record of a live process
     * whose probe failed or came late, and keeps its token and socket, so the
     * process comes back within one interval.
     */
    private void heal() {
        PeerEndpoint bound = endpoint;
        if (closed || bound == null) {
            return;
        }
        boolean current = registry.read(self.pid())
                .filter(r -> self.procStart().equals(r.procStart()))
                .filter(r -> bound.socket().toString().equals(r.socket()))
                .isPresent();
        if (!current) {
            changed();
        }
    }

    /** Writes the record now, on the caller's thread. */
    public synchronized void flush() {
        if (closed || endpoint == null) {
            return;
        }
        registry.write(record());
        recordWrites.incrementAndGet();
        idleTransitions();
    }

    /**
     * Card 503: the two clocks of an idle subscription, shortened by a test.
     *
     * @param lifetime how long a subscription waits for its notice
     * @param debounce how long a session stays idle before its subscribers hear it
     */
    void idleTimings(Duration lifetime, Duration debounce) {
        this.idleLifetime = lifetime;
        this.idleDebounce = debounce;
    }

    /** @return how long a subscription waits for its notice (card 503 tests) */
    Duration idleLifetime() {
        return idleLifetime;
    }

    /** @return how long a session stays idle before its subscribers hear it (card 503 tests) */
    Duration idleDebounce() {
        return idleDebounce;
    }

    /** @return how many times this node wrote its record */
    long recordWrites() {
        return recordWrites.get();
    }

    /** @return the record as it would be written now */
    public synchronized LiveRecord record() {
        List<LiveRecord.Session> rows = new ArrayList<>();
        long now = System.currentTimeMillis();
        for (PeerSession session : host.sessions()) {
            PeerNames.Named named = PeerNames.name(session.cwd(), session.id(), session.title());
            rows.add(new LiveRecord.Session(session.id(), uniqueName(session, named), named.source(),
                    session.cwd(), session.running() ? "busy" : "idle", session.statusLine(), session.turn(),
                    session.mode() == null ? "ask" : session.mode(), session.since(), now));
        }
        PeerEndpoint bound = endpoint;
        return new LiveRecord(self.pid(), self.procStart(), startedAt, host.face(), version, PeerLimits.PROTOCOL,
                List.of("notify_idle"), bound == null ? null : bound.socket().toString(),
                host.attended() && host.accepting(), rows);
    }

    /**
     * Lists the registry, unlinks the dead records and keeps the result for
     * the name check.
     *
     * @return every live record, this process's own among them
     */
    public List<LiveRecord> roster() {
        List<LiveRecord> live = registry.list().live();
        roster = live;
        return live;
    }

    /** @return the records of the last listing, without listing again */
    public List<LiveRecord> lastRoster() {
        return roster;
    }

    /**
     * @param sessionId one of this process's sessions
     * @return the name peers address it by
     */
    public String nameOf(String sessionId) {
        String name = names.get(sessionId);
        if (name != null) {
            return name;
        }
        PeerSession session = find(sessionId);
        return session == null ? sessionId
                : PeerNames.name(session.cwd(), session.id(), session.title()).name();
    }

    /** @return the process id this node registers as (card 503) */
    public long pid() {
        return self.pid();
    }

    /** @return this process's reply address */
    public String address() {
        PeerEndpoint bound = endpoint;
        return bound == null ? null : "uds:" + bound.socket();
    }

    /**
     * Card 503: the address a message's {@code from} carries, which names the
     * sending session as well as its process, so a reply reaches that session
     * even when the process hosts several.
     *
     * @param sessionId the sending session
     * @return {@code uds:<socket>/<session id>}, or the process address for an id that cannot be a path segment
     */
    public String replyAddress(String sessionId) {
        String process = address();
        if (process == null || sessionId == null || !sessionId.matches("[A-Za-z0-9_-]{1,80}")) {
            return process;
        }
        return process + "/" + sessionId;
    }

    /**
     * Sends a message to a live session by name.
     *
     * @param fromSessionId the sending session of this process
     * @param to            the name, or the session id
     * @param text          the body
     * @param summary       a short line, or null for the first line of the body
     * @return what happened
     */
    public SendResult send(String fromSessionId, String to, String text, String summary) {
        for (LiveRecord record : roster()) {
            for (LiveRecord.Session session : record.sessions()) {
                boolean itself = record.pid() == self.pid() && session.id().equals(fromSessionId);
                if (!itself && (PeerNames.same(session.name(), to) || session.id().equals(to))) {
                    return sendTo(fromSessionId, record, session.id(), session.name(), text, summary);
                }
            }
        }
        return new SendResult(false, null, PeerClient.Error.UNKNOWN_NAME, PeerClient.unknownName(to));
    }

    /**
     * Sends a message to one session of a resolved record.
     *
     * @param fromSessionId the sending session
     * @param target        the receiving process's record
     * @param toSession     the receiving session id
     * @param name          the name the sender used
     * @param text          the body
     * @param summary       a short line, or null
     * @return what happened
     */
    public SendResult sendTo(String fromSessionId, LiveRecord target, String toSession, String name, String text,
                             String summary) {
        String msgId = PeerFrames.newMsgId();
        if (!pacer.tryAcquire(target.pid() + "/" + toSession)) {
            return new SendResult(false, msgId, PeerClient.Error.PACED,
                    SenderPacer.pacedText(PeerLimits.BUCKET_CAPACITY));
        }
        PeerSession from = find(fromSessionId);
        currentRecord();
        String body = text == null ? "" : text;
        PeerEnvelope envelope = PeerEnvelope.builder()
                .msgId(msgId)
                .toSession(toSession)
                .from(replyAddress(fromSessionId))
                .fromSession(fromSessionId)
                .fromName(nameOf(fromSessionId))
                .fromMode(PermissionClass.of(from == null ? null : from.mode()))
                .hopChain(List.of(PeerNames.hop(fromSessionId)))
                .priority("next")
                .text(body)
                .summary(summary != null ? summary : firstLine(body))
                .build();
        sent.put(msgId, new Sent(fromSessionId, target.pid(), name, true));
        PeerClient.Result result = client.send(target, name, PeerFrames.message(envelope));
        if (!result.sent()) {
            sent.remove(msgId);
            log.info("peer message {} to pid {} not sent: {}", msgId, target.pid(), result.error());
            return new SendResult(false, msgId, result.error(), result.text());
        }
        log.info("peer message {} to pid {} sent", msgId, target.pid());
        correspondents.computeIfAbsent(fromSessionId, k -> ConcurrentHashMap.newKeySet()).add(target.pid());
        sidecar.envelope(fromSessionId, "sent", envelope, name);
        if (from != null) {
            from.onPeerEvent(new PeerEvent("message", "sent", envelope, msgId, null, null, null, name));
        }
        return new SendResult(true, msgId, null, null);
    }

    /**
     * Asks a peer for one notice when it is next idle.
     *
     * @param fromSessionId the subscribing session
     * @param target        the watched process's record
     * @param toSession     the watched session
     * @param name          its name
     * @return what happened
     */
    public SendResult notifyWhenIdle(String fromSessionId, LiveRecord target, String toSession, String name) {
        String msgId = PeerFrames.newMsgId();
        long outstanding = sent.values().stream()
                .filter(entry -> !entry.message() && entry.sessionId().equals(fromSessionId)).count();
        if (outstanding >= PeerLimits.IDLE_OUTSTANDING_CAP) {
            return new SendResult(false, null, null, PeerNotices.idleCap());
        }
        PeerSession from = find(fromSessionId);
        currentRecord();
        Sent subscription = new Sent(fromSessionId, target.pid(), name, false);
        sent.put(msgId, subscription);
        PeerClient.Result result = client.send(target, name, PeerFrames.notifyWhenIdle(msgId, address(),
                fromSessionId, PermissionClass.of(from == null ? null : from.mode()), toSession));
        if (!result.sent()) {
            sent.remove(msgId);
        } else {
            subscriptionExpiry.put(msgId, timers.schedule(() -> expireSubscription(msgId, subscription),
                    idleLifetime.toMillis(), TimeUnit.MILLISECONDS));
        }
        return new SendResult(result.sent(), msgId, result.error(), result.text());
    }

    /** Card 503: a subscription that heard nothing within its lifetime says so once and ends. */
    private void expireSubscription(String msgId, Sent subscription) {
        subscriptionExpiry.remove(msgId);
        if (!sent.remove(msgId, subscription)) {
            return;
        }
        PeerSession session = find(subscription.sessionId());
        if (session == null) {
            return;
        }
        String name = subscription.name() == null ? "the other session" : subscription.name();
        String notice = PeerNotices.expired(name, Math.max(1, idleLifetime.toHours()));
        session.inbox().notice(notice);
        session.onPeerEvent(new PeerEvent("idle_notice", "received", null, msgId, null, "expired", notice, name));
    }

    /**
     * The operator's Deliver or Decline on a held message.
     *
     * @param sessionId the session that holds it
     * @param msgId     the message
     * @param deliver   true to deliver, false to decline
     */
    public void decide(String sessionId, String msgId, boolean deliver) {
        Held entry = held.get(msgId);
        if (entry == null || !entry.sessionId().equals(sessionId) || !held.remove(msgId, entry)) {
            return;
        }
        entry.expiry().cancel(false);
        PeerSession session = find(sessionId);
        if (!deliver) {
            reply(entry.envelope(), sessionId, PeerStatus.DENIED, null, null);
            tellThePage(session, entry.envelope(), PeerStatus.DENIED);
            return;
        }
        if (session == null) {
            reply(entry.envelope(), sessionId, PeerStatus.REFUSED, null, "the session is gone");
            return;
        }
        tellThePage(session, entry.envelope(), PeerStatus.DELIVERED);
        place(session, entry.envelope(), true);
    }

    /** Card 503: the receiving page learns what became of a message held for its operator. */
    private static void tellThePage(PeerSession session, PeerEnvelope envelope, PeerStatus status) {
        if (session != null) {
            session.onPeerEvent(new PeerEvent("status", "received", null, envelope.msgId(), status,
                    PeerNotices.statusReason(status), null, envelope.fromName()));
        }
    }

    @Override
    public void close() {
        synchronized (this) {
            if (closed) {
                return;
            }
            closed = true;
        }
        Thread running = writer;
        if (running != null) {
            running.interrupt();
        }
        exitedNotices();
        timers.shutdownNow();
        PeerEndpoint bound = endpoint;
        if (bound != null) {
            bound.close();
        }
        registry.delete(self.pid());
        log.info("peer registry record {} deleted", self.pid());
    }

    // ── receiving ────────────────────────────────────────────────────────

    private void onFrame(JsonNode frame, long verifiedPid) {
        switch (frame.path("type").asText()) {
            case "message" -> {
                Vouched vouched = vouched(PeerFrames.envelope(frame), verifiedPid);
                receive(vouched.envelope(), vouched.senderKey());
            }
            case "peer_message_status" -> statusArrived(frame, verifiedPid);
            case "notify_when_idle" -> subscribe(frame, verifiedPid);
            case "peer_idle_notice" -> idleNoticeArrived(frame, verifiedPid);
            case "rename" -> renameArrived(frame);
            default -> { }
        }
    }

    /**
     * An envelope with the sender's class and name taken from the registry,
     * and the key its guards count it under.
     *
     * @param envelope  the envelope
     * @param senderKey the verified pid and the sending session when the
     *                  sender's record lists that session, else the pid alone
     */
    private record Vouched(PeerEnvelope envelope, String senderKey) {
    }

    /**
     * The sender's class and name as the registry states them for the verified
     * pid and the sending session, not as the frame claims (concept decision
     * 4). A sending session the record does not list has no class, and an
     * idle receiver holds its message; it is named as unregistered, and every
     * unlisted session of one pid shares one bucket and one duplicate window.
     * A listed name keeps only the characters {@link PeerNames#clean} allows,
     * cut as {@link PeerNames#shown} cuts it.
     */
    private Vouched vouched(PeerEnvelope claimed, long verifiedPid) {
        PeerEnvelope envelope = claimed.withVerifiedPeerPid(verifiedPid);
        Optional<LiveRecord.Session> row = registry.read(verifiedPid).flatMap(record -> record.sessions().stream()
                .filter(s -> s.id().equals(claimed.fromSession())).findFirst());
        if (row.isEmpty()) {
            return new Vouched(envelope.withSender("unregistered pid " + verifiedPid, null),
                    verifiedPid + "/unlisted");
        }
        String name = PeerNames.shown(row.get().name());
        return new Vouched(envelope.withSender(name.isEmpty() ? "unnamed pid " + verifiedPid : name,
                PermissionClass.of(row.get().mode())), verifiedPid + "/" + row.get().id());
    }

    /** Rewrites this process's record now when it is missing or out of date, before a send. */
    private void currentRecord() {
        flush();
    }

    private void receive(PeerEnvelope envelope, String sender) {
        String sessionId = envelope.toSession();
        log.info("peer message {} from pid {} arrived", envelope.msgId(), envelope.verifiedPeerPid());
        PeerSession session = find(sessionId);
        if (session == null) {
            boolean child = host.sessions().stream().anyMatch(s -> s.isChild(sessionId));
            reply(envelope, null, PeerStatus.REFUSED, null,
                    child ? "a child of a run takes no message from a peer session" : "no such session here");
            return;
        }
        sidecar.envelope(sessionId, "received", envelope, nameOf(sessionId));
        DeliveryPolicy.Action action = DeliveryPolicy.decide(host.attended(), host.accepting(), session.running(),
                session.mode(), envelope.fromMode());
        if (action == DeliveryPolicy.Action.REFUSE) {
            reply(envelope, sessionId, PeerStatus.REFUSED, null, null);
            return;
        }
        int queued = session.inbox().size() + (int) held.values().stream()
                .filter(h -> h.sessionId().equals(sessionId)).count();
        Optional<DropReason> drop = guards.computeIfAbsent(sessionId, k -> new IngressGuard(System::currentTimeMillis))
                .admit(sender, envelope.text(), envelope.hopChain(), PeerNames.hop(sessionId), queued);
        if (drop.isPresent()) {
            reply(envelope, sessionId, PeerStatus.DROPPED, drop.get(), null);
            return;
        }
        if (envelope.verifiedPeerPid() != null) {
            correspondents.computeIfAbsent(sessionId, k -> ConcurrentHashMap.newKeySet())
                    .add(envelope.verifiedPeerPid());
        }
        session.onPeerEvent(new PeerEvent("message", "received", envelope, envelope.msgId(), null, null, null,
                envelope.fromName()));
        if (action == DeliveryPolicy.Action.HOLD) {
            hold(session, envelope);
        } else {
            place(session, envelope, false);
        }
    }

    /** Puts a message where the session reads it: its running loop, or a new run. */
    private void place(PeerSession session, PeerEnvelope envelope, boolean afterHold) {
        hook(session);
        // Card 503: the run this message starts counts its body as absorbed,
        // so the relay rule reads it from the first turn.
        session.inbox().startingMessage(envelope.text());
        if (!session.running() && session.startRun(AgentMessageBlock.render(envelope, false))) {
            reply(envelope, session.id(), PeerStatus.DELIVERED, null, afterHold ? AFTER_HOLD : null);
            return;
        }
        session.inbox().forgetStarting(envelope.text());
        if (!session.running()) {
            // A face that cannot start a run while it is idle (the REPL waits
            // on its prompt) holds the message for the operator instead.
            hold(session, envelope);
            return;
        }
        switch (session.inbox().submit(envelope)) {
            case WAITING -> {
                if (afterHold) {
                    releasedAfterHold.add(envelope.msgId());
                }
            }
            case FULL -> reply(envelope, session.id(), PeerStatus.DROPPED, DropReason.QUEUE_FULL, null);
            case NO_RUN -> retryWhenIdle(session, List.of(envelope), afterHold);
        }
    }

    private void hold(PeerSession session, PeerEnvelope envelope) {
        ScheduledFuture<?> expiry = timers.schedule(() -> expire(session.id(), envelope.msgId()),
                heldExpiry.toMillis(), TimeUnit.MILLISECONDS);
        held.put(envelope.msgId(), new Held(envelope, session.id(), expiry));
        reply(envelope, session.id(), PeerStatus.HELD, null, null);
        session.onPeerEvent(new PeerEvent("held", "received", envelope, envelope.msgId(), PeerStatus.HELD,
                PeerNotices.statusReason(PeerStatus.HELD), null, envelope.fromName()));
    }

    private void expire(String sessionId, String msgId) {
        Held entry = held.remove(msgId);
        if (entry != null) {
            reply(entry.envelope(), sessionId, PeerStatus.EXPIRED, null, null);
            tellThePage(find(sessionId), entry.envelope(), PeerStatus.EXPIRED);
        }
    }

    /** The inbox tells the node what the loop absorbed and what a closing run left. */
    private void hook(PeerSession session) {
        PeerInbox inbox = session.inbox();
        if (!hooked.add(inbox)) {
            return;
        }
        inbox.onAbsorbed(taken -> {
            for (PeerEnvelope envelope : taken) {
                boolean afterHold = releasedAfterHold.remove(envelope.msgId());
                reply(envelope, session.id(), PeerStatus.DELIVERED, null, afterHold ? AFTER_HOLD : null);
            }
        });
        inbox.onUnread(unread -> retryWhenIdle(session, unread, false));
    }

    /** A message the run did not read is delivered again once the session is idle. */
    private void retryWhenIdle(PeerSession session, List<PeerEnvelope> envelopes, boolean afterHold) {
        Thread.ofVirtual().name("spectro-peer-retry").start(() -> {
            long until = System.currentTimeMillis() + 30_000;
            while (session.running() && System.currentTimeMillis() < until && !closed) {
                try {
                    Thread.sleep(50);
                } catch (InterruptedException stopped) {
                    return;
                }
            }
            for (PeerEnvelope envelope : envelopes) {
                boolean released = afterHold || releasedAfterHold.remove(envelope.msgId());
                DeliveryPolicy.Action action = released ? DeliveryPolicy.Action.START_RUN
                        : DeliveryPolicy.decide(host.attended(), host.accepting(), session.running(),
                        session.mode(), envelope.fromMode());
                switch (action) {
                    case REFUSE -> reply(envelope, session.id(), PeerStatus.REFUSED, null, null);
                    case HOLD -> hold(session, envelope);
                    default -> place(session, envelope, released);
                }
            }
        });
    }

    /** Sends a status to the sender and writes it into the receiving session's sidecar. */
    private void reply(PeerEnvelope envelope, String sessionId, PeerStatus status, DropReason drop, String detail) {
        log.info("peer message {} from pid {} status {}", envelope.msgId(), envelope.verifiedPeerPid(),
                status.wireName());
        String reason = drop != null ? drop.text() : PeerNotices.statusReason(status);
        if (sessionId != null) {
            sidecar.status(sessionId, "received", envelope.msgId(), status, reason);
        }
        Long pid = envelope.verifiedPeerPid();
        if (pid == null) {
            return;
        }
        JsonNode frame = PeerFrames.status(envelope.msgId(), envelope.fromSession(), status, address(), drop, detail);
        Thread.ofVirtual().name("spectro-peer-status").start(() -> registry.read(pid).ifPresent(record -> {
            PeerClient.Result result = client.send(record, envelope.fromName(), frame);
            if (!result.sent()) {
                log.info("peer status {} for message {} not sent: {}", status.wireName(), envelope.msgId(),
                        result.error());
            }
        }));
    }

    private void statusArrived(JsonNode frame, long verifiedPid) {
        String msgId = frame.path("orig_msg_id").asText(null);
        PeerStatus status = PeerStatus.of(frame.path("status").asText());
        Sent entry = msgId == null ? null : sent.get(msgId);
        if (entry == null || !entry.message() || entry.pid() != verifiedPid || status == null) {
            log.info("peer status for an unknown message from pid {} ignored", verifiedPid);
            return;
        }
        if (status == PeerStatus.HELD) {
            if (!heldAnswered.add(msgId)) {
                return;
            }
        } else if (!sent.remove(msgId, entry)) {
            return;
        } else {
            heldAnswered.remove(msgId);
        }
        String sessionId = entry.sessionId();
        PeerSession session = find(sessionId);
        if (session == null) {
            return;
        }
        boolean afterHold = AFTER_HOLD.equals(frame.path("status_detail").asText(null));
        DropReason drop = null;
        for (DropReason candidate : DropReason.values()) {
            if (candidate.wireName().equals(frame.path("drop_reason").asText(null))) {
                drop = candidate;
            }
        }
        String name = entry.name() == null ? "the other session" : entry.name();
        String notice = PeerNotices.notice(status, name, drop, afterHold);
        String detail = frame.path("status_detail").asText(null);
        String reason = detail != null && !afterHold ? detail : frame.path("reason").asText(null);
        log.info("peer message {} status {} reported", msgId, status.wireName());
        sidecar.status(sessionId, "sent", msgId, status, reason);
        if (PeerNotices.tellsTheModel(status, afterHold)) {
            session.inbox().notice(notice);
        }
        session.onPeerEvent(new PeerEvent("status", "sent", null, msgId, status, reason, notice, name));
    }

    private void subscribe(JsonNode frame, long pid) {
        String sessionId = frame.path("to_session").asText();
        if (find(sessionId) == null) {
            return;
        }
        subscribers.computeIfAbsent(sessionId, k -> new java.util.concurrent.CopyOnWriteArrayList<>())
                .add(new Subscriber(frame.path("msg_id").asText(), pid, frame.path("from_session").asText()));
    }

    /**
     * Card 503: a session that went from busy to idle arms one notice per
     * subscriber, sent once the debounce has run out and only if the session
     * is idle then. A run that starts again first holds it until the next idle.
     */
    private void idleTransitions() {
        for (PeerSession session : host.sessions()) {
            boolean now = session.running();
            Boolean before = wasRunning.put(session.id(), now);
            // A run that starts again before the debounce runs out is caught
            // when it fires (idleNow reads running), and the next idle arms anew.
            if (!now && Boolean.TRUE.equals(before) && subscribers.containsKey(session.id())) {
                long finished = System.currentTimeMillis();
                String detail = PeerNotices.idleText(session.lastText());
                String id = session.id();
                ScheduledFuture<?> armed = timers.schedule(() -> idleNow(id, finished, detail),
                        idleDebounce.toMillis(), TimeUnit.MILLISECONDS);
                ScheduledFuture<?> previous = idleDebounces.put(id, armed);
                if (previous != null) {
                    previous.cancel(false);
                }
            }
        }
    }

    /** Card 503: the debounce ran out; a session still idle answers every subscriber once. */
    private void idleNow(String sessionId, long finished, String detail) {
        idleDebounces.remove(sessionId);
        PeerSession session = find(sessionId);
        if (session == null || session.running() || closed) {
            return;
        }
        List<Subscriber> waiting = subscribers.remove(sessionId);
        if (waiting == null) {
            return;
        }
        for (Subscriber subscriber : waiting) {
            JsonNode notice = PeerFrames.idleNotice(subscriber.msgId(), "idle", finished, detail, address(),
                    sessionId);
            Thread.ofVirtual().start(() -> registry.read(subscriber.pid()).ifPresent(record ->
                    client.send(record, nameOf(sessionId), notice)));
        }
    }

    /** Card 503: a process that ends tells every subscriber still waiting, and waits a moment for the sends. */
    private void exitedNotices() {
        List<Thread> sends = new ArrayList<>();
        for (Map.Entry<String, List<Subscriber>> entry : subscribers.entrySet()) {
            for (Subscriber subscriber : entry.getValue()) {
                JsonNode notice = PeerFrames.idleNotice(subscriber.msgId(), "exited", System.currentTimeMillis(),
                        null, address(), entry.getKey());
                sends.add(Thread.ofVirtual().start(() -> registry.read(subscriber.pid()).ifPresent(record ->
                        client.send(record, nameOf(entry.getKey()), notice))));
            }
        }
        subscribers.clear();
        long until = System.currentTimeMillis() + 1_000;
        for (Thread send : sends) {
            try {
                send.join(Math.max(1, until - System.currentTimeMillis()));
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private void idleNoticeArrived(JsonNode frame, long verifiedPid) {
        String msgId = frame.path("orig_msg_id").asText(null);
        Sent entry = msgId == null ? null : sent.get(msgId);
        if (entry == null || entry.message() || entry.pid() != verifiedPid || !sent.remove(msgId, entry)) {
            log.info("peer idle notice for an unknown subscription from pid {} ignored", verifiedPid);
            return;
        }
        PeerSession session = find(entry.sessionId());
        if (session == null) {
            return;
        }
        ScheduledFuture<?> expiry = subscriptionExpiry.remove(msgId);
        if (expiry != null) {
            expiry.cancel(false);
        }
        String name = entry.name() == null ? "the other session" : entry.name();
        String notice;
        if ("exited".equals(frame.path("state").asText())) {
            notice = PeerNotices.exited(name);
        } else {
            long at = frame.path("finished_at").asLong(System.currentTimeMillis());
            String time = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())
                    .format(Instant.ofEpochMilli(at));
            notice = PeerNotices.idle(name, time, PeerNotices.idleText(frame.path("detail").asText(null)));
        }
        session.inbox().notice(notice);
        session.onPeerEvent(new PeerEvent("idle_notice", "received", null, msgId, null, null, notice, name));
    }

    private void renameArrived(JsonNode frame) {
        String name = PeerNames.clean(frame.path("name").asText());
        String oldName = PeerNames.clean(frame.path("old_name").asText());
        for (PeerSession session : host.sessions()) {
            session.onPeerEvent(new PeerEvent("rename", "received", null, null, null, oldName, null, name));
        }
    }

    // ── names ────────────────────────────────────────────────────────────

    private String uniqueName(PeerSession session, PeerNames.Named named) {
        List<PeerNames.Claim> claims = new ArrayList<>();
        for (LiveRecord record : roster) {
            if (record.pid() == self.pid()) {
                continue;
            }
            for (LiveRecord.Session other : record.sessions()) {
                if (other.name() != null) {
                    claims.add(new PeerNames.Claim(record.startedAt(), record.procStart(), record.pid(), other.id(),
                            other.name()));
                }
            }
        }
        for (PeerSession own : host.sessions()) {
            PeerNames.Named base = PeerNames.name(own.cwd(), own.id(), own.title());
            claims.add(new PeerNames.Claim(startedAt, self.procStart(), self.pid(), own.id(), base.name()));
        }
        PeerNames.Claim mine = new PeerNames.Claim(startedAt, self.procStart(), self.pid(), session.id(),
                named.name());
        String chosen = PeerNames.yields(mine, claims) ? PeerNames.loserName(named.name(), session.id())
                : named.name();
        String before = names.put(session.id(), chosen);
        if (before != null && !before.equals(chosen)) {
            announceRename(session.id(), before, chosen);
        }
        return chosen;
    }

    private void announceRename(String sessionId, String oldName, String name) {
        log.info("session {} renamed for uniqueness", sessionId);
        Set<Long> pids = correspondents.getOrDefault(sessionId, Set.of());
        JsonNode frame = PeerFrames.rename(sessionId, oldName, name);
        for (long pid : pids) {
            Thread.ofVirtual().start(() -> registry.read(pid).ifPresent(record -> client.send(record, oldName, frame)));
        }
    }

    // ── plumbing ─────────────────────────────────────────────────────────

    private PeerSession find(String sessionId) {
        if (sessionId == null) {
            return null;
        }
        for (PeerSession session : host.sessions()) {
            if (session.id().equals(sessionId)) {
                return session;
            }
        }
        return null;
    }

    private void writeLoop() {
        while (!closed) {
            try {
                pending.take();
                flush();
            } catch (InterruptedException stopped) {
                return;
            } catch (RuntimeException failure) {
                log.warn("peer registry record not written: {}", failure.toString());
            }
        }
    }

    /**
     * @param text a body
     * @return its first line, the summary of an envelope that names none, cut at
     *         {@link PeerLimits#SUMMARY_CAP} without splitting a surrogate pair
     */
    static String firstLine(String text) {
        String line = text.strip();
        int newline = line.indexOf('\n');
        if (newline >= 0) {
            line = line.substring(0, newline);
        }
        return line.length() > PeerLimits.SUMMARY_CAP ? PeerNotices.cut(line, PeerLimits.SUMMARY_CAP) : line;
    }
}
