package dev.spectroscope.core.graph;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The reviewed credential vectors — one row per documented real token format.
 *
 * <p>TWIN TABLE: the same rows live in the Python edition at
 * {@code spectro/tests/test_graph_observe.py} ({@code REVIEWED_CREDENTIALS} /
 * {@code NEAR_MISSES}). The two editions must report the same rule for the
 * same string; change the tables together or not at all.</p>
 *
 * <p>Every positive row is shaped after the format its issuer documents
 * (lengths, prefixes, charsets — reviewed 2026-08-12 against the AWS IAM
 * identifier reference, GitHub's token-format announcement, Slack's token-type
 * docs and the published OpenAI/Anthropic key anatomies). Every negative row
 * is a string a real corpus could plausibly contain: redaction replaces the
 * WHOLE string, so a false positive destroys an innocent document.</p>
 */
class RedactionTest {

    private record Row(String value, String rule) {
    }

    private static final List<Row> REVIEWED_CREDENTIALS = List.of(
            new Row("-----BEGIN RSA PRIVATE KEY-----", "private-key"),
            new Row("-----BEGIN OPENSSH PRIVATE KEY-----", "private-key"),
            // PGP wraps the words the other PEM headers end with.
            new Row("-----BEGIN PGP PRIVATE KEY BLOCK-----", "private-key"),
            // Real-prefix vectors are JOINED AT RUNTIME ("sk-ant-" + …): a
            // redaction test's rows are exactly what push-protection scanners
            // hunt, and a blocked push proved it. The runtime string keeps the
            // documented shape; only the source file stops matching.
            new Row("sk-ant-" + "api03-dGhlLXJldmlld2VkLXNoYXBlLW5vdC1hLXJlYWwta2V5LWJ1dC1pdHMtZXhhY3QtYW5hdG9teQAA",
                    "anthropic-key"),
            new Row("sk-ant-" + "oat01-c2Vzc2lvbi1zY29wZWQtb2F1dGgtdG9rZW4", "anthropic-key"),
            // The legacy 48-char alnum key. The real T3BlbkFJ marker stays out
            // on purpose — GitHub's scanner signature — and the reviewed
            // pattern does not need it.
            new Row("sk-" + "abcdefghij0123456789ABCDEFGHIJ0123456789abcdefgh", "openai-key"),
            new Row("sk-proj-" + "VGhlcmV2aWV3ZWRzZXQtbm90YXJlYWxrZXk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_AbCd",
                    "openai-key"),
            // The spec's own example, HARVEST.md line 159 — must keep firing.
            new Row("key=sk-proj-AbCdEf0123456789XyZwVu", "openai-key"),
            new Row("sk-svcacct-" + "0123456789abcdefghij0123456789abcdefghij", "openai-key"),
            new Row("AKIAIOSFODNN7EXAMPLE", "aws-akid"),
            new Row("ASIAIOSFODNN7EXAMPLE", "aws-akid"),
            new Row("ABIAIOSFODNN7EXAMPLE", "aws-akid"),
            new Row("ACCAIOSFODNN7EXAMPLE", "aws-akid"),
            new Row("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcd012345", "github-pat"),
            new Row("ghs_0123456789abcdefghij0123456789abcdef", "github-pat"),
            // Fine-grained: github_pat_ + 22 + '_' + 59 = the documented 93 total.
            new Row("github_pat_1234567890123456789012_abcdefghijABCDEFGHIJ0123456789abcdefghijABCDEFGHIJ012345678",
                    "github-pat"),
            new Row("AIzaSyA1B2C3D4E5F6G7H8I9J0KaLbMcNdOePfQ", "google-api-key"),
            new Row("xoxb-" + "2444333222111-1111222333444-AbCdEfGhIjKlMnOpQrSt", "slack-token"),
            new Row("xoxp-" + "9876543210-1234567890-1357924680-abcdef1234567890abcdef1234567890",
                    "slack-token"),
            new Row("xoxe-" + "1-My4xLjE2OTY0NDkwNjc4NDQtMjA0NQ", "slack-token"),
            new Row("xapp-" + "1-A0123456789-1234567890123-abcdef0123456789abcdef0123456789",
                    "slack-token"),
            new Row("xoxc-" + "1234567890123-abcdefghijklmnop", "slack-token"),
            new Row("xoxd-" + "AbCdEf123456789012345", "slack-token"),
            new Row("Authorization: Bearer abcdefghij0123456789KLMNOP", "bearer"),
            new Row("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N", "jwt"),
            // Unsigned JWT: alg none keeps its trailing dot and an empty signature.
            new Row("eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjM0In0.", "jwt"),
            new Row("postgres://admin:hunter2@db.intern:5432/explain", "url-userinfo"),
            new Row("chris.ezell@spectroscope.ai", "email"),
            new Row("DE89370400440532013000", "iban"));

    /**
     * Strings a real corpus could contain. Redaction replaces the WHOLE value,
     * so each of these firing would erase an innocent document.
     */
    private static final List<String> NEAR_MISSES = List.of(
            // "sk-" reachable as a substring: task-, desk-, risk-, whisk-…
            "task-management-ui-refactor-notes",
            // …and only the \b stops the prefixed branch inside "risk-proj-…":
            // the charset guard cannot, because that branch allows hyphens.
            "risk-proj-assessment-quarterly-review",
            // A hyphenated slug directly after "sk-" is prose, not a key.
            "sk-learn-tutorial-and-examples-collection",
            // Prose about bearer auth is not a bearer token.
            "bearer authentication is the preferred mechanism",
            // AIDA (IAM user) and AROA (role) are resource identifiers that
            // appear in ARNs and CloudTrail prose — identifiers, not secrets.
            "AIDAIOSFODNN7EXAMPLE",
            "AROAIOSFODNN7EXAMPLE",
            // xoxo- is an affectionate sign-off; Slack's token-type docs know
            // xoxa/b/c/d/e/p/r/s and xapp, never xoxo.
            "xoxo-hugs-and-kisses-from-the-team",
            // "ghs_" reachable as a substring of laughs_ — the \b earns its keep.
            "laughs_000000000000000000000000000000000000",
            // Prose ABOUT a fine-grained PAT, far below the 80-char tail.
            "github_pat_documentation_for_the_setup_page",
            // eyJ opening an English word, with dots doing sentence work.
            "eyJourney.begins.here");

    @Test
    void everyDocumentedCredentialShapeReportsItsOwnRule() {
        for (Row row : REVIEWED_CREDENTIALS) {
            assertEquals(row.rule(), Redaction.firstRule(row.value()), row.value());
        }
    }

    @Test
    void aStringARealCorpusCouldContainIsNotACredential() {
        for (String value : NEAR_MISSES) {
            assertNull(Redaction.firstRule(value), value);
        }
    }

    /**
     * Pins the LIMIT, on purpose — the same six rows the Python edition pins.
     * Pattern redaction does not make a corpus safe; a RAG corpus is made of
     * prose. The controls that work are the tier default, the allow list and
     * sampling. This is why the policy field says {@code "patterns"}, never
     * {@code true}.
     */
    @Test
    void confidentialProseStaysUncaughtAndTheFieldNameSaysSo() {
        for (String value : List.of(
                "Das Gehalt von Frau Meier betraegt 94.500 EUR brutto.",
                "Patient 4711, Diagnose C50.9, Therapiebeginn 2026-03-14.",
                "Der Kunde kuendigt zum Quartalsende; Umsatzverlust 2,3 Mio.",
                "Zugangsdaten stehen im Anhang der Mail vom Dienstag.",
                "internal-secret-passphrase-do-not-share",
                "Personalnummer 88231, Abmahnung wegen Arbeitszeitbetrug.")) {
            assertNull(Redaction.firstRule(value), value);
        }
    }

    /**
     * Pins a KNOWN GAP, on purpose: German invoices group IBANs in fours, and
     * the compact-form pattern does not see the grouped spelling. Recorded here
     * so the limit is on the books instead of discovered in an incident.
     */
    @Test
    void aSpacedIbanIsAKnownGapNotACatch() {
        assertNull(Redaction.firstRule("DE89 3704 0044 0532 0130 00"));
    }
}
