package dev.spectroscope.orchestrator;

/**
 * One evicted stretch of bus history, announced to the subscriber that
 * missed it (card 22): the ring is bounded, so falling far enough behind
 * loses frames — and losing them LOUDLY is the contract (KONZEPT §8 trap 1
 * forbids silent loss, not loss). Consumers receive gaps through
 * {@code onGap} handlers on the transports.
 *
 * @param topic   the topic the subscriber was catching up on
 * @param sender  the sender whose frames were evicted
 * @param fromSeq the first missing sequence, inclusive
 * @param toSeq   the last missing sequence, inclusive
 */
public record BusGap(String topic, String sender, long fromSeq, long toSeq) {
}
