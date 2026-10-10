package dev.spectroscope.core.playbook.run;

import java.util.List;
import java.util.stream.Collectors;

/**
 * What a check answered.
 *
 * @param label  the outcome label, or null when the check produced none
 * @param detail what a person reads in the sidecar
 */
public record CheckResult(String label, String detail) {

    public static CheckResult pass(String detail) {
        return new CheckResult("pass", detail);
    }

    public static CheckResult fail(String detail) {
        return new CheckResult("fail", detail);
    }

    /** @param parts per document results; @return pass when every part passed */
    public static CheckResult all(List<CheckResult> parts) {
        boolean ok = parts.stream().allMatch(p -> "pass".equals(p.label()));
        String detail = parts.stream().map(CheckResult::detail).collect(Collectors.joining("; "));
        return new CheckResult(ok ? "pass" : "fail", detail);
    }
}
