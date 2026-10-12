package dev.spectroscope.core.peer;

/**
 * Something a session's face should learn about agent messaging (card 502):
 * a message sent or received, a held message, a status, a rename, an idle
 * notice. The server turns each into a {@code peer_message} frame.
 *
 * @param kind      {@code message}, {@code held}, {@code status}, {@code rename} or {@code idle_notice}
 * @param direction {@code sent} or {@code received}
 * @param envelope  the message, for {@code message} and {@code held}; else null
 * @param msgId     the message the event is about
 * @param status    the status, for {@code status}; else null
 * @param reason    the reporting side's reason, or null
 * @param notice    the text the sending model reads, for {@code status}; else null
 * @param name      the other session's name
 */
public record PeerEvent(String kind, String direction, PeerEnvelope envelope, String msgId, PeerStatus status,
                        String reason, String notice, String name) {
}
