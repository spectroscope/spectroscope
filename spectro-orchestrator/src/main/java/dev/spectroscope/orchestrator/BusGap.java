package dev.spectroscope.orchestrator;

/**
 * One evicted stretch of bus history, announced to the subscriber that
 * missed it: the replay ring is bounded, so falling far enough behind loses
 * frames — and losing them LOUDLY is the contract (this transport forbids
 * silent loss, not loss). Consumers receive gaps through {@code onGap}
 * handlers on the transports. Gaps are scoped per (sender, epoch) — each
 * incarnation's history is its own.
 *
 * @param topic   the topic the subscriber was catching up on
 * @param sender  the sender whose frames were evicted
 * @param epoch   the incarnation the evicted frames belonged to
 * @param fromSeq the first missing sequence, inclusive
 * @param toSeq   the last missing sequence, inclusive
 */
public record BusGap(String topic, String sender, long epoch, long fromSeq, long toSeq) {
}
