package dev.spectroscope.core.peer;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * One message between two agents, as the {@code message} frame carries it
 * (card 502 criterion 4, concept section Inbox).
 *
 * @param msgId           a UUID minted by the sender; every status frame echoes it
 * @param toSession       the receiving session id, or a child name inside a run
 * @param from            the reply address of the sender, {@code uds:<socket path>}
 * @param fromSession     the sending session id
 * @param fromName        the sending session's name
 * @param fromMode        the sender's permission class
 * @param hopChain        the hop ids the message passed through, oldest first
 * @param priority        {@code next} (the default) or {@code now}
 * @param text            the body
 * @param summary         a short line for listings
 * @param fromPid         the pid the sender's process stated in its auth frame
 * @param verifiedPeerPid the pid the receiver checked against the registry, or null
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PeerEnvelope(String msgId, String toSession, String from, String fromSession,
                           String fromName, String fromMode, List<String> hopChain, String priority,
                           String text, String summary, Long fromPid, Long verifiedPeerPid) {

    /** Normalises the chain to an immutable list. */
    public PeerEnvelope {
        hopChain = hopChain == null ? List.of() : List.copyOf(hopChain);
    }

    /** @return a builder with every field null */
    public static Builder builder() {
        return new Builder();
    }

    /** @param chain the new chain @return a copy carrying it */
    public PeerEnvelope withHopChain(List<String> chain) {
        return new PeerEnvelope(msgId, toSession, from, fromSession, fromName, fromMode, chain, priority,
                text, summary, fromPid, verifiedPeerPid);
    }

    /** @param id the new id @return a copy carrying it */
    public PeerEnvelope withMsgId(String id) {
        return new PeerEnvelope(id, toSession, from, fromSession, fromName, fromMode, hopChain, priority,
                text, summary, fromPid, verifiedPeerPid);
    }

    /** @param pid the pid the receiver checked @return a copy carrying it */
    public PeerEnvelope withVerifiedPeerPid(Long pid) {
        return new PeerEnvelope(msgId, toSession, from, fromSession, fromName, fromMode, hopChain, priority,
                text, summary, fromPid, pid);
    }

    /**
     * @param name     the sender's name as the registry lists it
     * @param mode     the sender's class as the registry lists it, or null when unknown
     * @return a copy carrying both in place of the claimed ones
     */
    public PeerEnvelope withSender(String name, String mode) {
        return new PeerEnvelope(msgId, toSession, from, fromSession, name, mode, hopChain, priority,
                text, summary, fromPid, verifiedPeerPid);
    }

    /** Builder for the twelve fields. */
    public static final class Builder {
        private String msgId;
        private String toSession;
        private String from;
        private String fromSession;
        private String fromName;
        private String fromMode;
        private List<String> hopChain;
        private String priority;
        private String text;
        private String summary;
        private Long fromPid;
        private Long verifiedPeerPid;

        /** @param v the msg id @return this */
        public Builder msgId(String v) {
            msgId = v;
            return this;
        }

        /** @param v the receiving session @return this */
        public Builder toSession(String v) {
            toSession = v;
            return this;
        }

        /** @param v the reply address @return this */
        public Builder from(String v) {
            from = v;
            return this;
        }

        /** @param v the sending session id @return this */
        public Builder fromSession(String v) {
            fromSession = v;
            return this;
        }

        /** @param v the sending session name @return this */
        public Builder fromName(String v) {
            fromName = v;
            return this;
        }

        /** @param v the sender's permission class @return this */
        public Builder fromMode(String v) {
            fromMode = v;
            return this;
        }

        /** @param v the hop chain @return this */
        public Builder hopChain(List<String> v) {
            hopChain = v;
            return this;
        }

        /** @param v next or now @return this */
        public Builder priority(String v) {
            priority = v;
            return this;
        }

        /** @param v the body @return this */
        public Builder text(String v) {
            text = v;
            return this;
        }

        /** @param v the summary @return this */
        public Builder summary(String v) {
            summary = v;
            return this;
        }

        /** @param v the stated pid @return this */
        public Builder fromPid(Long v) {
            fromPid = v;
            return this;
        }

        /** @param v the verified pid @return this */
        public Builder verifiedPeerPid(Long v) {
            verifiedPeerPid = v;
            return this;
        }

        /** @return the envelope */
        public PeerEnvelope build() {
            return new PeerEnvelope(msgId, toSession, from, fromSession, fromName, fromMode, hopChain,
                    priority, text, summary, fromPid, verifiedPeerPid);
        }
    }
}
