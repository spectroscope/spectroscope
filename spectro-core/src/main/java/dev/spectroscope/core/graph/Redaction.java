package dev.spectroscope.core.graph;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The credential shapes that make a string unrecordable.
 *
 * <p>A string in which any rule fires is replaced WHOLE. Partial masking would
 * leave the tail of a key, which is still a key, and prose surviving beside a
 * marker invites a reader to believe the rest is fine. Redaction therefore also
 * runs BEFORE clipping, so a clipped prefix can never end mid-credential.</p>
 *
 * <p>What this is not: a promise that confidential prose is caught. It catches
 * shapes, and only shapes — which is exactly why the policy field is the string
 * {@code "patterns"} and never a boolean.</p>
 */
final class Redaction {

    /** A named shape. The order of the list is the order the rules fire in. */
    private record Rule(String name, Pattern pattern) {
    }

    /*
     * Reviewed 2026-08-12 against the issuers' documented formats (AWS IAM
     * identifier reference, GitHub's token-format announcement, Slack's
     * token-type docs, the published OpenAI/Anthropic key anatomies). The rule
     * NAMES and their firing order are pinned by the measured spec
     * (docs/graph-spec/HARVEST.md:213); the patterns are this review. The twin
     * vector table in RedactionTest is shared verbatim with the Python edition.
     */
    private static final List<Rule> RULES = List.of(
            // [A-Z ]* covers RSA/EC/DSA/OPENSSH/ENCRYPTED; PGP appends " BLOCK".
            new Rule("private-key", Pattern.compile("-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----")),
            // Anthropic before OpenAI: both start "sk-", so the more specific
            // rule has to be asked first or every Anthropic key would be
            // reported under the wrong name.
            new Rule("anthropic-key", Pattern.compile("\\bsk-ant-[A-Za-z0-9_-]{16,}")),
            // Two documented anatomies: the prefixed families and the legacy
            // 48-char alnum key. The generic branch takes no hyphens on
            // purpose — a slug like "sk-learn-…" is prose, and a fired rule
            // erases the WHOLE string it fired in.
            new Rule("openai-key", Pattern.compile(
                    "\\bsk-(?:(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{32,})")),
            // Credential prefixes only: long-term, STS, bearer, context.
            // AIDA/AROA/AGPA/… are resource identifiers that live in ARNs and
            // CloudTrail prose — identifiers, not secrets.
            new Rule("aws-akid", Pattern.compile("\\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16,17}\\b")),
            // The 2021 formats: gh?_ + 36 alnum, fine-grained github_pat_ + 82.
            new Rule("github-pat", Pattern.compile(
                    "\\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{80,})")),
            new Rule("google-api-key", Pattern.compile("\\bAIza[0-9A-Za-z_-]{35}")),
            // Slack's documented families plus app-level xapp. xoxo- stays
            // out: an affectionate sign-off, not a token prefix.
            new Rule("slack-token", Pattern.compile("\\b(?:xox[abcdeprs]|xapp)-[A-Za-z0-9-]{10,}")),
            // 16 as the floor keeps prose like "bearer authentication" out.
            new Rule("bearer", Pattern.compile("(?i)\\bbearer\\s+[A-Za-z0-9._~+/=-]{16,}")),
            // Compact JWS: b64url header past eyJ, payload, both dots; the
            // signature may be empty (alg none keeps its trailing dot).
            new Rule("jwt", Pattern.compile("\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]*")),
            new Rule("url-userinfo", Pattern.compile("\\b[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s/@:]+:[^\\s/@]+@")),
            new Rule("email", Pattern.compile("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}")),
            // Compact form only; the spaced grouping is a pinned known gap.
            new Rule("iban", Pattern.compile("\\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\\b")));

    private Redaction() {
    }

    /**
     * @param value the string a node wrote
     * @return the name of the first rule that fires, or {@code null} for none
     */
    static String firstRule(String value) {
        for (Rule rule : RULES) {
            if (rule.pattern().matcher(value).find()) {
                return rule.name();
            }
        }
        return null;
    }

    /**
     * The coarse size band a redacted value reports instead of its length.
     *
     * <p>An exact length is a small oracle — enough of one that it is already a
     * recorded open finding against the llm-wire, and a defect on the books is not
     * repeated here. Measured in UTF-8 bytes, like every other size in this
     * dialect.</p>
     */
    static String bucket(String value) {
        int bytes = value.getBytes(StandardCharsets.UTF_8).length;
        if (bytes <= 8) {
            return "1-8";
        }
        if (bytes <= 16) {
            return "9-16";
        }
        if (bytes <= 32) {
            return "17-32";
        }
        if (bytes <= 64) {
            return "33-64";
        }
        if (bytes <= 128) {
            return "65-128";
        }
        return "129+";
    }
}
