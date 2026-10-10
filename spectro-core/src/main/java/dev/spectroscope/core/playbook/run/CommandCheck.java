package dev.spectroscope.core.playbook.run;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.config.governing.Governs;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.tools.ShellCommand;

import java.nio.file.Path;
import java.util.Map;
import java.util.Optional;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A command check: the host guard first, then the session's gate under the
 * name playbook_check, the way the goal check asks (Agent.approvedCheck),
 * then the shell. Exit 0 passes.
 */
public final class CommandCheck {

    /** The name the check asks the permission gate under. */
    public static final String GATE_NAME = "playbook_check";
    /** The wall clock budget of one check line, in seconds. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.SECONDS)
    public static final long TIMEOUT_SECONDS = 900;
    /** How many characters of a check line's output are kept, the tail, for the sidecar and the failure text. */
    @Governs(kind = Governs.Kind.FIXED, unit = Governs.Unit.CHARACTERS)
    static final int MAX_OUTPUT_CHARS = 4000;
    private static final Pattern VAR = Pattern.compile("\\{([A-Za-z_][A-Za-z0-9_]*)}");

    private CommandCheck() {
    }

    /**
     * Fills the playbook's vars into a check line.
     *
     * @param run  the check's line
     * @param vars the playbook's vars
     * @return the line with every declared var filled in; an undeclared one stays as written
     */
    public static String substitute(String run, Map<String, String> vars) {
        Matcher m = VAR.matcher(run);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String value = vars.get(m.group(1));
            m.appendReplacement(out, Matcher.quoteReplacement(value != null ? value : m.group()));
        }
        m.appendTail(out);
        return out.toString();
    }

    /**
     * Runs one command check after the host guard and the gate allowed it.
     *
     * @param command     the line, vars already filled in
     * @param cwd         the session's working folder
     * @param broker      the session's gate
     * @param hostRefusal the host guard's reading of a line
     * @param emit        the session drain
     * @param signal      the decision's signal
     * @param callId      the id the request and decision carry
     * @return pass on exit 0, else fail with the reason
     */
    public static CheckResult run(String command, Path cwd, PermissionBroker broker,
                                  Function<String, Optional<String>> hostRefusal, Consumer<RunEvent> emit,
                                  CancelSignal signal, String callId) {
        Optional<String> refused = hostRefusal.apply(command);
        if (refused.isPresent()) {
            return CheckResult.fail("refused by the host guard: " + refused.get());
        }
        RunEvent.PermissionRequest bare = new RunEvent.PermissionRequest("main", callId, GATE_NAME,
                JsonNodeFactory.instance.objectNode().put("command", command), System.currentTimeMillis());
        RunEvent.PermissionRequest request = bare.stamped(broker.decidedBy(bare));
        emit.accept(request);
        boolean allowed = broker.decide(request);
        emit.accept(new RunEvent.PermissionDecision(callId, allowed, System.currentTimeMillis()));
        if (!allowed || signal.isCancelled()) {
            return CheckResult.fail("not run, the permission gate refused: " + command);
        }
        ShellCommand.Result result = ShellCommand.run(command, Map.of(), cwd, TIMEOUT_SECONDS, signal,
                MAX_OUTPUT_CHARS, true);
        if (result.timedOut()) {
            return CheckResult.fail("timed out after " + TIMEOUT_SECONDS + " s: " + command);
        }
        if (result.failure() != null) {
            return CheckResult.fail("could not run: " + result.failure());
        }
        return result.exitCode() == 0
                ? CheckResult.pass("exit 0: " + command)
                : CheckResult.fail("exit " + result.exitCode() + ": " + command + "\n" + result.output());
    }
}
