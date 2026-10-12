package dev.spectroscope.server.playbooks;

import dev.spectroscope.core.graph.Redaction;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.provider.Arguments;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeSet;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * One credential per rule of the wire redaction, taken from the reviewed vector table in
 * {@code RedactionTest} (card 538). The prefixes are joined at run time, as there, so the source
 * does not match a push-protection scanner. The test below fails when the redaction gains a rule
 * this table has no vector for.
 */
class HookTokenVectors {

    /** Rule name to a string the rule fires on. */
    static final Map<String, String> BY_RULE = new LinkedHashMap<>();

    static {
        BY_RULE.put("private-key", "-----BEGIN RSA " + "PRIVATE KEY-----");
        BY_RULE.put("anthropic-key", "sk-ant-" + "api03-dGhlLXJldmlld2VkLXNoYXBlLW5vdC1hLXJlYWwta2V5LWJ1dC1pdHMtZXhhY3QtYW5hdG9teQAA");
        BY_RULE.put("openai-key", "sk-proj-" + "VGhlcmV2aWV3ZWRzZXQtbm90YXJlYWxrZXk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_AbCd");
        BY_RULE.put("aws-akid", "AKIA" + "IOSFODNN7EXAMPLE");
        BY_RULE.put("github-pat", "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcd012345");
        BY_RULE.put("google-api-key", "AIza" + "SyA1B2C3D4E5F6G7H8I9J0KaLbMcNdOePfQ");
        BY_RULE.put("slack-token", "xoxb-" + "2444333222111-1111222333444-AbCdEfGhIjKlMnOpQrSt");
        BY_RULE.put("bearer", "Authorization: Bearer " + "abcdefghij0123456789KLMNOP");
        BY_RULE.put("jwt", "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N");
        BY_RULE.put("url-userinfo", "postgres://admin:" + "hunter2@db.intern:5432/explain");
        BY_RULE.put("email", "owner" + "@example.com");
        BY_RULE.put("iban", "DE89" + "370400440532013000");
    }

    /** The rows as JUnit arguments: the rule name and its string. */
    static Stream<Arguments> families() {
        return BY_RULE.entrySet().stream().map(e -> Arguments.of(e.getKey(), e.getValue()));
    }

    @Test
    void everyRuleOfTheRedactionHasAVectorHereAndEachFiresItsOwnRule() {
        assertEquals(new TreeSet<>(Redaction.ruleNames()), new TreeSet<>(BY_RULE.keySet()));
        BY_RULE.forEach((rule, value) -> assertEquals(rule, Redaction.firstRule("echo " + value), value));
    }
}
