package dev.spectroscope.core.tools;

import dev.spectroscope.core.tools.ShellWords.Command;
import dev.spectroscope.core.tools.ShellWords.Pipeline;
import dev.spectroscope.core.tools.ShellWords.Word;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import java.util.stream.Collectors;

/**
 * Card 396: the check that keeps {@code run_command} from stopping the app it
 * runs in.
 *
 * <p>On 2026-09-23 an agent in the desktop app ran {@code pkill -f} three
 * times with a pattern that matched its own app, in auto mode, and three runs
 * ended with it. This guard reads the line before any shell starts and
 * refuses it when one of these shapes would reach a protected process:</p>
 * <ul>
 *   <li>{@code kill} with a numeric target in the set; a negative number is a
 *       process group, {@code 0} is the caller's own group, {@code -1} is
 *       every process, and {@code $PPID} is read as this JVM, also inside a
 *       {@code sh -c} the line starts. There it is this JVM when run_command's
 *       shell expanded it in double quotes or when the inner shell replaced
 *       run_command's own; after {@code cd /tmp &&} it is run_command's shell,
 *       and the guard refuses that as well;</li>
 *   <li>{@code pkill}, whose pattern, read as a regular expression, matches the
 *       command line ({@code -f}) or the executable name of a protected
 *       process;</li>
 *   <li>{@code killall NAME} where NAME is a protected executable name;</li>
 *   <li>{@code pgrep}, {@code lsof} on this server's own port, or {@code ps}
 *       narrowed by {@code grep}, feeding {@code xargs kill} through a pipe or
 *       {@code kill} through {@code $(...)} or backquotes.</li>
 * </ul>
 *
 * <p>The protected set is computed per call: this JVM, its ancestors up to
 * PID 1, and the children of its direct parent unless that parent is PID 1.
 * Under the desktop app that is the server, the Electron main process and the
 * Electron helpers. The ports are the ones {@link #protectPort} was told
 * about, which the server does for its own HTTP port.</p>
 *
 * <p>It reads the line and does not run it. A target hidden in a variable, a
 * file, a script or another language gets through; {@code HostGuardTest} pins
 * those cases so nobody mistakes this for a sandbox.</p>
 */
public final class HostGuard {

    private static final Logger log = LoggerFactory.getLogger(HostGuard.class);

    /**
     * One process as the guard sees it.
     *
     * @param pid         the process id
     * @param executable  the executable path, or null when the system does not say
     * @param commandLine the full command line, or null when the system does not say
     */
    public record Proc(long pid, String executable, String commandLine) {

        /**
         * The executable's file name, which pkill and killall match without -f.
         *
         * @return the name, or null when the system says nothing about the process
         */
        public String name() {
            String path = executable;
            if (path == null && commandLine != null && !commandLine.isBlank()) {
                path = commandLine.strip().split("\\s+", 2)[0];
            }
            if (path == null) {
                return null;
            }
            int slash = path.lastIndexOf('/');
            return slash < 0 ? path : path.substring(slash + 1);
        }
    }

    /** Where the guard reads the process tree from. */
    public interface ProcessTable {
        /**
         * This JVM.
         *
         * @return its pid
         */
        long self();

        /**
         * A process's parent.
         *
         * @param pid a process id
         * @return its parent's pid, empty when it has none or is gone
         */
        Optional<Long> parentOf(long pid);

        /**
         * A process's direct children.
         *
         * @param pid a process id
         * @return their pids
         */
        List<Long> childrenOf(long pid);

        /**
         * What the system says about one process.
         *
         * @param pid a process id
         * @return its executable and command line, empty when it is gone
         */
        Optional<Proc> describe(long pid);

        /**
         * The process groups of some processes.
         *
         * @param pids process ids
         * @return the group of each pid the system could answer for
         */
        Map<Long, Long> groupsOf(Collection<Long> pids);
    }

    /** The ports this server listens on, as the server reported them. */
    private static final Set<Integer> OWN_PORTS = ConcurrentHashMap.newKeySet();

    private static final Set<String> KEYWORDS = Set.of(
            "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}");
    private static final Set<String> SHELLS = Set.of("sh", "bash", "zsh", "dash", "ksh");
    private static final Set<String> GREPS = Set.of("grep", "egrep", "fgrep");
    private static final Set<String> SIGNALS = Set.of(
            "HUP", "INT", "QUIT", "ILL", "TRAP", "ABRT", "IOT", "EMT", "FPE", "KILL", "BUS",
            "SEGV", "SYS", "PIPE", "ALRM", "TERM", "URG", "STOP", "TSTP", "CONT", "CHLD", "TTIN",
            "TTOU", "IO", "XCPU", "XFSZ", "VTALRM", "PROF", "WINCH", "INFO", "USR1", "USR2", "PWR");
    private static final Pattern ASSIGNMENT = Pattern.compile("[A-Za-z_][A-Za-z0-9_]*=.*",
            Pattern.DOTALL);
    private static final Pattern NUMBER = Pattern.compile("-?\\d+");
    /** pgrep and pkill letters that take a value, on macOS and Linux together. */
    private static final String PGREP_VALUE_LETTERS = "FGMNPUdgstu";
    /** killall letters that take a value; -c names a process, -s is Linux's signal. */
    private static final String KILLALL_VALUE_LETTERS = "ctusZoyn";
    /** lsof letters whose value is the rest of the word. */
    private static final String LSOF_VALUE_LETTERS = "cdDeEfFgkKmoOprsSTuxz";
    /** xargs letters that take a separate value when none is attached. */
    private static final String XARGS_VALUE_LETTERS = "ILnPsEJRdaS";
    private static final String TAIL = " This command would stop the app that runs this agent:"
            + " this server, the window or terminal that started it, or one of its helper"
            + " processes. Nothing in the command ran. If the app needs a restart, ask the"
            + " person who runs it.";

    private final ProcessTable table;
    private final Set<Integer> ports;

    private HostGuard(ProcessTable table, Set<Integer> ports) {
        this.table = table;
        this.ports = ports;
    }

    /**
     * Tells every later guard that this server listens on a port.
     *
     * @param port the port; zero and below are ignored
     */
    public static void protectPort(int port) {
        if (port > 0) {
            OWN_PORTS.add(port);
        }
    }

    /**
     * The ports reported through {@link #protectPort}.
     *
     * @return a copy, as of now
     */
    public static Set<Integer> protectedPorts() {
        return Set.copyOf(OWN_PORTS);
    }

    /**
     * The guard over this JVM's real process tree and reported ports.
     *
     * @return the guard; it reads nothing until a line has a kill shape in it
     */
    public static HostGuard live() {
        return new HostGuard(new LiveTable(), OWN_PORTS);
    }

    /**
     * A guard over an explicit table and port set.
     *
     * @param table the process tree to read
     * @param ports the ports this server listens on
     * @return the guard
     */
    public static HostGuard over(ProcessTable table, Set<Integer> ports) {
        return new HostGuard(table, Set.copyOf(ports));
    }

    /**
     * The refusal for one shell line.
     *
     * @param command the shell line run_command was asked to run
     * @return the {@code ERROR: refused} text, empty when the line may run
     */
    public Optional<String> refusal(String command) {
        try {
            List<Aim> aims = aimsIn(command, 0, true);
            if (aims.isEmpty()) {
                return Optional.empty();
            }
            List<Proc> guarded = protectedProcesses();
            for (Aim aim : aims) {
                Optional<String> refused = aim.judge(guarded, this);
                if (refused.isPresent()) {
                    return refused;
                }
            }
            return Optional.empty();
        } catch (RuntimeException unreadable) {
            // The line runs as it would have before this guard existed.
            log.warn("host guard: could not check a run_command line, it runs unchecked",
                    unreadable);
            return Optional.empty();
        }
    }

    /**
     * The protected set, computed now: this JVM first, then its ancestors
     * nearest first up to PID 1, then the other children of its direct parent
     * when that parent is not PID 1.
     *
     * @return the protected processes, each once
     */
    public List<Proc> protectedProcesses() {
        Map<Long, Proc> set = new LinkedHashMap<>();
        long self = table.self();
        add(set, self);
        Optional<Long> parent = table.parentOf(self);
        Optional<Long> up = parent;
        while (up.isPresent() && !set.containsKey(up.get())) {
            add(set, up.get());
            if (up.get() <= 1) {
                break;
            }
            up = table.parentOf(up.get());
        }
        // Under PID 1 the parent's children are every app it started, not this
        // server's host: ./spectro-serve start and an orphaned server land there.
        parent.filter(direct -> direct > 1)
                .ifPresent(direct -> table.childrenOf(direct).forEach(child -> add(set, child)));
        return List.copyOf(set.values());
    }

    private void add(Map<Long, Proc> set, long pid) {
        if (!set.containsKey(pid)) {
            set.put(pid, table.describe(pid).orElse(new Proc(pid, null, null)));
        }
    }

    // ---- reading the line ---------------------------------------------------------------

    /**
     * Every kill shape in one line, in the order the line states them.
     *
     * @param line     the text to read
     * @param depth    how deep the substitutions and nested shells go so far
     * @param ownShell true while the text runs in run_command's own shell,
     *                 false inside a shell the line starts; {@code $PPID} is
     *                 read as this JVM in both, and the refusal says which
     */
    private List<Aim> aimsIn(String line, int depth, boolean ownShell) {
        List<Aim> aims = new ArrayList<>();
        if (depth > 8) {
            return aims;
        }
        for (Pipeline pipeline : ShellWords.parse(line)) {
            List<Command> stages = pipeline.stages();
            for (int k = 0; k < stages.size(); k++) {
                for (Word word : stages.get(k).words()) {
                    for (String inner : word.substitutions()) {
                        aims.addAll(aimsIn(inner, depth + 1, ownShell));
                    }
                }
                Optional<Invocation> call = invocation(stages.get(k).words());
                if (call.isPresent()) {
                    aims.addAll(aimsOf(call.get(), stages, k, depth, ownShell));
                }
            }
        }
        return aims;
    }

    private List<Aim> aimsOf(Invocation call, List<Command> stages, int at, int depth,
                             boolean ownShell) {
        List<Word> args = call.args();
        switch (call.name()) {
            case "kill":
                return killAims(args, depth, ownShell);
            case "pkill":
                return matchAim("pkill pattern", args, List.of()).map(List::<Aim>of).orElse(List.of());
            case "killall":
                return killallAim(args).map(List::<Aim>of).orElse(List.of());
            case "xargs":
                if (at > 0 && xargsRunsKill(args)) {
                    return producer(stages.get(0), stages.subList(1, at))
                            .map(List::<Aim>of).orElse(List.of());
                }
                return List.of();
            case "eval":
                return aimsIn(args.stream().map(Word::text).collect(Collectors.joining(" ")),
                        depth + 1, ownShell);
            default:
                if (SHELLS.contains(call.name())) {
                    Optional<String> script = shellScript(args);
                    if (script.isPresent()) {
                        return aimsIn(script.get(), depth + 1, false);
                    }
                }
                return List.of();
        }
    }

    /** A command with its prefixes taken off.
     *  @param name the command's file name
     *  @param args the words after it */
    private record Invocation(String name, List<Word> args) {
    }

    /** Skips assignments, keywords and the wrappers that run the next word as the command. */
    private static Optional<Invocation> invocation(List<Word> words) {
        int k = 0;
        int size = words.size();
        while (k < size) {
            String word = words.get(k).text();
            if (KEYWORDS.contains(word) || ASSIGNMENT.matcher(word).matches()) {
                k++;
                continue;
            }
            String base = basename(word);
            switch (base) {
                case "sudo", "doas" -> {
                    k++;
                    while (k < size && words.get(k).text().startsWith("-")) {
                        String option = words.get(k).text();
                        k += Set.of("-u", "-g", "-p", "-C", "-D", "-h", "-r", "-t", "-U")
                                .contains(option) ? 2 : 1;
                    }
                }
                case "command" -> {
                    k++;
                    if (k < size && Set.of("-v", "-V").contains(words.get(k).text())) {
                        return Optional.empty(); // a lookup, nothing runs
                    }
                    while (k < size && words.get(k).text().startsWith("-")) {
                        k++;
                    }
                }
                case "builtin", "nohup", "time", "exec" -> {
                    k++;
                    while (k < size && words.get(k).text().startsWith("-")) {
                        k += "exec".equals(base) && "-a".equals(words.get(k).text()) ? 2 : 1;
                    }
                }
                case "env" -> {
                    k++;
                    while (k < size && (words.get(k).text().startsWith("-")
                            || ASSIGNMENT.matcher(words.get(k).text()).matches())) {
                        k += Set.of("-u", "-C", "-P", "-S").contains(words.get(k).text()) ? 2 : 1;
                    }
                }
                case "nice" -> {
                    k++;
                    while (k < size && words.get(k).text().startsWith("-")) {
                        k += "-n".equals(words.get(k).text()) ? 2 : 1;
                    }
                }
                case "timeout" -> {
                    k++;
                    while (k < size && words.get(k).text().startsWith("-")) {
                        k += Set.of("-s", "-k").contains(words.get(k).text()) ? 2 : 1;
                    }
                    k++; // the duration
                }
                default -> {
                    return Optional.of(new Invocation(base, words.subList(k + 1, size)));
                }
            }
        }
        return Optional.empty();
    }

    private static String basename(String word) {
        int slash = word.lastIndexOf('/');
        return slash < 0 ? word : word.substring(slash + 1);
    }

    private static Optional<String> shellScript(List<Word> args) {
        for (int k = 0; k < args.size(); k++) {
            String word = args.get(k).text();
            if (word.startsWith("--")) {
                continue;
            }
            if (!word.startsWith("-")) {
                return Optional.empty();
            }
            if (word.indexOf('c') > 0 && k + 1 < args.size()) {
                return Optional.of(args.get(k + 1).text());
            }
        }
        return Optional.empty();
    }

    private static boolean isSignal(String body) {
        if (!body.isEmpty() && body.chars().allMatch(Character::isDigit)) {
            return true;
        }
        String name = body.startsWith("SIG") ? body.substring(3) : body;
        return SIGNALS.contains(name);
    }

    private static boolean known(Word word) {
        return !word.expands() && word.substitutions().isEmpty();
    }

    // ---- kill ------------------------------------------------------------------------

    private List<Aim> killAims(List<Word> args, int depth, boolean ownShell) {
        List<Aim> aims = new ArrayList<>();
        if (args.isEmpty()) {
            return aims;
        }
        String first = args.get(0).text();
        if (first.equals("-l") || first.equals("-L")) {
            return aims;
        }
        int k = 0;
        if (first.equals("-s") || first.equals("-n")) {
            k = 2;
        } else if (first.startsWith("-") && first.length() > 1) {
            k = 1; // the signal, or "--"
        }
        if (k == 1 && !first.equals("--") && k < args.size() && args.get(k).text().equals("--")) {
            k++;
        } else if (k == 2 && k < args.size() && args.get(k).text().equals("--")) {
            k++;
        }
        List<Target> targets = new ArrayList<>();
        for (int j = k; j < args.size(); j++) {
            Word word = args.get(j);
            for (String inner : word.substitutions()) {
                for (Pipeline pipeline : ShellWords.parse(inner)) {
                    List<Command> stages = pipeline.stages();
                    producer(stages.get(0), stages.subList(1, stages.size())).ifPresent(aims::add);
                }
            }
            String text = word.text();
            if (text.equals("$PPID") || text.equals("${PPID}")) {
                targets.add(new Target(text,
                        ownShell ? Target.Kind.SELF : Target.Kind.NESTED_SELF, table.self()));
            } else if (known(word) && NUMBER.matcher(text).matches()) {
                long number = Long.parseLong(text);
                if (number > 0) {
                    targets.add(new Target(text, Target.Kind.PID, number));
                } else if (number == 0) {
                    targets.add(new Target(text, Target.Kind.OWN_GROUP, 0));
                } else if (number == -1) {
                    targets.add(new Target(text, Target.Kind.EVERYONE, -1));
                } else {
                    targets.add(new Target(text, Target.Kind.GROUP, -number));
                }
            }
        }
        if (!targets.isEmpty()) {
            aims.add(0, new Pids(targets));
        }
        return aims;
    }

    // ---- pkill, pgrep ----------------------------------------------------------------------

    private static Optional<Aim> matchAim(String label, List<Word> args, List<GrepFilter> filters) {
        boolean full = false;
        boolean exact = false;
        boolean ignoreCase = false;
        boolean invert = false;
        List<Long> parents = new ArrayList<>();
        List<String> patterns = new ArrayList<>();
        boolean unknownPattern = false;
        boolean options = true;
        for (int k = 0; k < args.size(); k++) {
            Word word = args.get(k);
            String text = word.text();
            if (!options || !text.startsWith("-") || text.equals("-")) {
                if (known(word)) {
                    patterns.add(text);
                } else {
                    unknownPattern = true;
                }
                continue;
            }
            if (text.equals("--")) {
                options = false;
                continue;
            }
            if (text.startsWith("--")) {
                switch (text) {
                    case "--full" -> full = true;
                    case "--exact" -> exact = true;
                    case "--ignore-case" -> ignoreCase = true;
                    case "--inverse" -> invert = true;
                    case "--signal", "--parent", "--group", "--session", "--terminal", "--euid",
                         "--uid", "--pidfile", "--delimiter" -> {
                        if ("--parent".equals(text) && k + 1 < args.size()) {
                            parents.addAll(numbers(args.get(k + 1).text()));
                        }
                        k++;
                    }
                    default -> { }
                }
                continue;
            }
            String body = text.substring(1);
            if (isSignal(body)) {
                continue;
            }
            for (int c = 0; c < body.length(); c++) {
                char letter = body.charAt(c);
                if (letter == 'f') {
                    full = true;
                } else if (letter == 'x') {
                    exact = true;
                } else if (letter == 'i') {
                    ignoreCase = true;
                } else if (letter == 'v') {
                    invert = true;
                } else if (PGREP_VALUE_LETTERS.indexOf(letter) >= 0) {
                    String value = body.substring(c + 1);
                    if (value.isEmpty() && k + 1 < args.size()) {
                        value = args.get(++k).text();
                    }
                    if (letter == 'P') {
                        parents.addAll(numbers(value));
                    }
                    break;
                }
            }
        }
        boolean positiveFilter = filters.stream().anyMatch(filter -> !filter.invert());
        if (patterns.isEmpty() && (unknownPattern || (parents.isEmpty() && !positiveFilter))) {
            return Optional.empty();
        }
        return Optional.of(new Match(label, patterns, full, exact, ignoreCase, invert,
                parents, filters));
    }

    private static List<Long> numbers(String list) {
        List<Long> out = new ArrayList<>();
        for (String part : list.split(",")) {
            if (NUMBER.matcher(part.strip()).matches()) {
                out.add(Long.parseLong(part.strip()));
            }
        }
        return out;
    }

    // ---- killall ------------------------------------------------------------------------------

    private static Optional<Aim> killallAim(List<Word> args) {
        boolean regex = false;
        boolean ignoreCase = false;
        List<String> names = new ArrayList<>();
        boolean options = true;
        for (int k = 0; k < args.size(); k++) {
            Word word = args.get(k);
            String text = word.text();
            if (!options || !text.startsWith("-") || text.equals("-")) {
                if (known(word)) {
                    names.add(text);
                }
                continue;
            }
            if (text.equals("--")) {
                options = false;
                continue;
            }
            if (text.startsWith("--")) {
                switch (text) {
                    case "--regexp" -> regex = true;
                    case "--ignore-case" -> ignoreCase = true;
                    case "--signal", "--user", "--older-than", "--younger-than", "--context",
                         "--ns" -> k++;
                    default -> { }
                }
                continue;
            }
            String body = text.substring(1);
            if (isSignal(body)) {
                continue;
            }
            for (int c = 0; c < body.length(); c++) {
                char letter = body.charAt(c);
                if (letter == 'm' || letter == 'r') {
                    regex = true;
                } else if (letter == 'I') {
                    ignoreCase = true;
                } else if (KILLALL_VALUE_LETTERS.indexOf(letter) >= 0) {
                    String value = body.substring(c + 1);
                    if (value.isEmpty() && k + 1 < args.size()) {
                        value = args.get(++k).text();
                    }
                    if (letter == 'c' && !value.isEmpty()) {
                        names.add(value);
                    }
                    break;
                }
            }
        }
        return names.isEmpty() ? Optional.empty()
                : Optional.of(new Names(names, regex, ignoreCase));
    }

    // ---- pipes and substitutions into kill -------------------------------------------------

    private static boolean xargsRunsKill(List<Word> args) {
        int k = 0;
        while (k < args.size()) {
            String text = args.get(k).text();
            if (!text.startsWith("-") || text.equals("-")) {
                break;
            }
            if (text.equals("--")) {
                k++;
                break;
            }
            k += text.length() == 2 && XARGS_VALUE_LETTERS.indexOf(text.charAt(1)) >= 0 ? 2 : 1;
        }
        if (k >= args.size()) {
            return false;
        }
        return invocation(args.subList(k, args.size()))
                .map(call -> call.name().equals("kill")).orElse(false);
    }

    /**
     * What the first command of a pipe selects, when the pipe ends in a kill.
     *
     * @param first   the command whose output becomes the pids
     * @param between the commands between it and the kill
     */
    private static Optional<Aim> producer(Command first, List<Command> between) {
        List<GrepFilter> filters = new ArrayList<>();
        for (Command stage : between) {
            invocation(stage.words()).filter(call -> GREPS.contains(call.name()))
                    .ifPresent(call -> filters.add(GrepFilter.of(call)));
        }
        Optional<Invocation> call = invocation(first.words());
        if (call.isEmpty()) {
            return Optional.empty();
        }
        return switch (call.get().name()) {
            case "pgrep" -> matchAim("pgrep pattern", call.get().args(), filters);
            case "lsof" -> portAim(call.get().args());
            case "ps" -> filters.stream().anyMatch(filter -> !filter.invert())
                    ? Optional.of(new Match("grep pattern", List.of(), true, false, false, false,
                            List.of(), filters))
                    : Optional.empty();
            default -> Optional.empty();
        };
    }

    private static Optional<Aim> portAim(List<Word> args) {
        List<String> specs = new ArrayList<>();
        for (int k = 0; k < args.size(); k++) {
            String text = args.get(k).text();
            if (!text.startsWith("-") || text.startsWith("--")) {
                continue;
            }
            String body = text.substring(1);
            for (int c = 0; c < body.length(); c++) {
                char letter = body.charAt(c);
                if (letter == 'i') {
                    String rest = body.substring(c + 1);
                    if (!rest.isEmpty()) {
                        specs.add(rest);
                    } else if (k + 1 < args.size() && !args.get(k + 1).text().startsWith("-")) {
                        specs.add(args.get(++k).text());
                    }
                    break;
                }
                if (LSOF_VALUE_LETTERS.indexOf(letter) >= 0) {
                    break;
                }
            }
        }
        List<int[]> ranges = new ArrayList<>();
        for (String spec : specs) {
            int colon = spec.lastIndexOf(':');
            if (colon < 0) {
                continue;
            }
            for (String item : spec.substring(colon + 1).split(",")) {
                String[] ends = item.split("-", 2);
                if (ends[0].matches("\\d{1,5}")) {
                    int low = Integer.parseInt(ends[0]);
                    int high = ends.length == 2 && ends[1].matches("\\d{1,5}")
                            ? Integer.parseInt(ends[1]) : low;
                    ranges.add(new int[] {low, high});
                }
            }
        }
        return ranges.isEmpty() ? Optional.empty() : Optional.of(new Ports(ranges));
    }

    // ---- the refusal ----------------------------------------------------------------------

    private static String refused(String label, String pattern, String note, Proc proc) {
        String name = proc.name() == null ? "name unknown" : proc.name();
        return "ERROR: refused: " + label + " \"" + pattern + "\""
                + (note == null ? "" : ", " + note + ",")
                + " matches protected PID " + proc.pid() + " (" + name + ")." + TAIL;
    }

    /** One way a line reaches for processes. */
    private interface Aim {
        /**
         * @param guarded the protected set, in its order
         * @param guard   the guard, for its table and ports
         * @return the refusal when the aim reaches a protected process
         */
        Optional<String> judge(List<Proc> guarded, HostGuard guard);
    }

    /** One {@code kill} operand.
     *  @param shown  the operand as written
     *  @param kind   what it names
     *  @param number the pid or group it names */
    private record Target(String shown, Kind kind, long number) {
        enum Kind { PID, SELF, NESTED_SELF, OWN_GROUP, EVERYONE, GROUP }
    }

    /** {@code kill} with literal operands. */
    private record Pids(List<Target> targets) implements Aim {
        @Override
        public Optional<String> judge(List<Proc> guarded, HostGuard guard) {
            Proc self = guarded.get(0);
            Map<Long, Long> groups = null;
            for (Target target : targets) {
                switch (target.kind()) {
                    case PID, SELF -> {
                        for (Proc proc : guarded) {
                            if (proc.pid() == target.number()) {
                                return Optional.of(refused("kill target", target.shown(), null, proc));
                            }
                        }
                    }
                    case NESTED_SELF -> {
                        return Optional.of(refused("kill target", target.shown(),
                                "inside a nested shell and read as this JVM", self));
                    }
                    case OWN_GROUP -> {
                        return Optional.of(refused("kill target", target.shown(),
                                "the process group of this command's shell, which holds this server", self));
                    }
                    case EVERYONE -> {
                        return Optional.of(refused("kill target", target.shown(),
                                "every process this user may signal", self));
                    }
                    case GROUP -> {
                        for (Proc proc : guarded) {
                            if (proc.pid() == target.number()) {
                                return Optional.of(refused("kill target", target.shown(),
                                        "process group " + target.number(), proc));
                            }
                        }
                        if (groups == null) {
                            groups = guard.table.groupsOf(
                                    guarded.stream().map(Proc::pid).toList());
                        }
                        for (Proc proc : guarded) {
                            Long group = groups.get(proc.pid());
                            if (group != null && group == target.number()) {
                                return Optional.of(refused("kill target", target.shown(),
                                        "process group " + target.number(), proc));
                            }
                        }
                    }
                    default -> { }
                }
            }
            return Optional.empty();
        }
    }

    /** pkill, pgrep, or ps narrowed by grep. */
    private record Match(String label, List<String> patterns, boolean full, boolean exact,
                         boolean ignoreCase, boolean invert, List<Long> parents,
                         List<GrepFilter> filters) implements Aim {
        @Override
        public Optional<String> judge(List<Proc> guarded, HostGuard guard) {
            for (Proc proc : guarded) {
                String hit = selects(proc, guard);
                if (hit != null) {
                    return Optional.of(refused(label, hit, null, proc));
                }
            }
            return Optional.empty();
        }

        /** @return the pattern that selects the process, or null when it is not selected */
        private String selects(Proc proc, HostGuard guard) {
            String hit = null;
            if (!patterns.isEmpty()) {
                String haystack = full
                        ? (proc.commandLine() != null ? proc.commandLine() : proc.executable())
                        : proc.name();
                boolean found = false;
                if (haystack != null) {
                    for (String pattern : patterns) {
                        if (Regex.found(pattern, haystack, exact, ignoreCase, !full)) {
                            hit = pattern;
                            found = true;
                            break;
                        }
                    }
                }
                if (invert) {
                    if (found || haystack == null) {
                        return null;
                    }
                    hit = patterns.get(0);
                } else if (!found) {
                    return null;
                }
            }
            if (!parents.isEmpty()) {
                Optional<Long> parent = guard.table.parentOf(proc.pid());
                if (parent.isEmpty() || !parents.contains(parent.get())) {
                    return null;
                }
                if (hit == null) {
                    hit = "-P " + parent.get();
                }
            }
            for (GrepFilter filter : filters) {
                if (!filter.accepts(proc.commandLine())) {
                    return null;
                }
                if (hit == null && !filter.invert() && !filter.patterns().isEmpty()) {
                    hit = filter.patterns().get(0);
                }
            }
            return hit;
        }
    }

    /** killall. */
    private record Names(List<String> names, boolean regex, boolean ignoreCase) implements Aim {
        @Override
        public Optional<String> judge(List<Proc> guarded, HostGuard guard) {
            for (Proc proc : guarded) {
                String own = proc.name();
                if (own == null) {
                    continue;
                }
                for (String name : names) {
                    boolean same = regex
                            ? Regex.found(name, own, false, ignoreCase, true)
                            : sameName(name, own, ignoreCase);
                    if (same) {
                        return Optional.of(refused("killall name", name, null, proc));
                    }
                }
            }
            return Optional.empty();
        }

        /** Equal, or equal in the first 15 characters, which is all of a long name the
         *  kernel keeps for killall to compare on Linux (16 on macOS). */
        private static boolean sameName(String name, String own, boolean ignoreCase) {
            String a = ignoreCase ? name.toLowerCase(Locale.ROOT) : name;
            String b = ignoreCase ? own.toLowerCase(Locale.ROOT) : own;
            if (a.equals(b)) {
                return true;
            }
            return a.length() >= 15 && b.length() >= 15 && a.startsWith(b.substring(0, 15));
        }
    }

    /** lsof on a port, piped into kill. */
    private record Ports(List<int[]> ranges) implements Aim {
        @Override
        public Optional<String> judge(List<Proc> guarded, HostGuard guard) {
            for (int port : guard.ports) {
                for (int[] range : ranges) {
                    if (port >= range[0] && port <= range[1]) {
                        return Optional.of(refused("lsof port", Integer.toString(port),
                                "this server's own port", guarded.get(0)));
                    }
                }
            }
            return Optional.empty();
        }
    }

    /** One grep between a process lister and the kill.
     *  @param patterns   its patterns, as Java regular expressions
     *  @param invert     -v
     *  @param ignoreCase -i
     *  @param unknown    a pattern this guard cannot read (-f FILE, a variable) */
    private record GrepFilter(List<String> patterns, boolean invert, boolean ignoreCase,
                              boolean unknown) {

        static GrepFilter of(Invocation call) {
            boolean invert = false;
            boolean ignoreCase = false;
            boolean extended = call.name().equals("egrep");
            boolean fixed = call.name().equals("fgrep");
            boolean word = false;
            boolean unknown = false;
            List<String> raw = new ArrayList<>();
            boolean explicit = false;
            List<Word> args = call.args();
            for (int k = 0; k < args.size(); k++) {
                Word arg = args.get(k);
                String text = arg.text();
                if (!text.startsWith("-") || text.equals("-")) {
                    if (!explicit && raw.isEmpty()) {
                        if (known(arg)) {
                            raw.add(text);
                        } else {
                            unknown = true;
                        }
                    }
                    continue;
                }
                if (text.startsWith("--")) {
                    if (text.startsWith("--regexp=")) {
                        raw.add(text.substring("--regexp=".length()));
                        explicit = true;
                    } else if (text.equals("--invert-match")) {
                        invert = true;
                    } else if (text.equals("--ignore-case")) {
                        ignoreCase = true;
                    }
                    continue;
                }
                String body = text.substring(1);
                for (int c = 0; c < body.length(); c++) {
                    char letter = body.charAt(c);
                    switch (letter) {
                        case 'v' -> invert = true;
                        case 'i' -> ignoreCase = true;
                        case 'E' -> extended = true;
                        case 'F' -> fixed = true;
                        case 'w' -> word = true;
                        default -> { }
                    }
                    if ("efmABCdD".indexOf(letter) >= 0) {
                        String value = body.substring(c + 1);
                        Word valueWord = null;
                        if (value.isEmpty() && k + 1 < args.size()) {
                            valueWord = args.get(++k);
                            value = valueWord.text();
                        }
                        if (letter == 'e') {
                            if (valueWord == null || known(valueWord)) {
                                raw.add(value);
                            } else {
                                unknown = true;
                            }
                            explicit = true;
                        } else if (letter == 'f') {
                            unknown = true;
                        }
                        break;
                    }
                }
            }
            List<String> patterns = new ArrayList<>();
            for (String pattern : raw) {
                String java = fixed ? Pattern.quote(pattern)
                        : Regex.posixClasses(extended ? pattern : Regex.basicToExtended(pattern));
                patterns.add(word ? "\\b(?:" + java + ")\\b" : java);
            }
            return new GrepFilter(patterns, invert, ignoreCase, unknown || raw.isEmpty());
        }

        /** @param line a process's command line, or null
         *  @return true when the process passes this grep */
        boolean accepts(String line) {
            if (unknown) {
                return true; // cannot tell, so it narrows nothing
            }
            boolean matched = false;
            if (line != null) {
                for (String pattern : patterns) {
                    if (Regex.compile(pattern, ignoreCase, false).matcher(line).find()) {
                        matched = true;
                        break;
                    }
                }
            }
            return invert != matched;
        }
    }

    /** POSIX patterns read as Java ones. */
    private static final class Regex {
        private Regex() {
        }

        private static final String[][] CLASSES = {
                {"[:alpha:]", "\\p{Alpha}"}, {"[:digit:]", "\\p{Digit}"},
                {"[:alnum:]", "\\p{Alnum}"}, {"[:upper:]", "\\p{Upper}"},
                {"[:lower:]", "\\p{Lower}"}, {"[:space:]", "\\s"},
                {"[:punct:]", "\\p{Punct}"}, {"[:xdigit:]", "\\p{XDigit}"},
                {"[:blank:]", "\\p{Blank}"}, {"[:cntrl:]", "\\p{Cntrl}"},
                {"[:print:]", "\\p{Print}"}, {"[:graph:]", "\\p{Graph}"}};

        /**
         * An extended POSIX pattern as a Java pattern; one Java cannot read is
         * taken as literal text.
         *
         * @param pattern    the pattern as written
         * @param ignoreCase -i
         * @param translate  true for a POSIX pattern whose bracket classes need translating
         */
        static Pattern compile(String pattern, boolean ignoreCase, boolean translate) {
            String java = translate ? posixClasses(pattern) : pattern;
            int flags = ignoreCase ? Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE : 0;
            try {
                return Pattern.compile(java, flags);
            } catch (PatternSyntaxException unreadable) {
                return Pattern.compile(Pattern.quote(pattern), flags);
            }
        }

        /**
         * Whether a pgrep-style pattern selects a name or command line.
         *
         * @param pattern    the pattern as written
         * @param haystack   the name or command line
         * @param exact      -x, the whole string must match
         * @param ignoreCase -i
         * @param isName     true when the haystack is an executable name the
         *                   kernel may keep shortened to 15 or 16 characters
         */
        static boolean found(String pattern, String haystack, boolean exact, boolean ignoreCase,
                             boolean isName) {
            Pattern compiled = compile(pattern, ignoreCase, true);
            if (!exact) {
                return compiled.matcher(haystack).find();
            }
            if (compiled.matcher(haystack).matches()) {
                return true;
            }
            if (isName) {
                for (int cut : new int[] {15, 16}) {
                    if (haystack.length() > cut
                            && compiled.matcher(haystack.substring(0, cut)).matches()) {
                        return true;
                    }
                }
            }
            return false;
        }

        /** @param pattern a POSIX pattern
         *  @return the same with its bracket classes, such as [:digit:], in Java's words */
        static String posixClasses(String pattern) {
            String java = pattern;
            for (String[] pair : CLASSES) {
                java = java.replace(pair[0], pair[1]);
            }
            return java;
        }

        /** grep's basic syntax, where {@code ( ) { } | + ?} are literal unless escaped. */
        static String basicToExtended(String basic) {
            StringBuilder out = new StringBuilder();
            for (int k = 0; k < basic.length(); k++) {
                char c = basic.charAt(k);
                if (c == '\\' && k + 1 < basic.length()) {
                    char next = basic.charAt(++k);
                    if ("(){}|+?".indexOf(next) >= 0) {
                        out.append(next);
                    } else {
                        out.append('\\').append(next);
                    }
                } else if ("(){}|+?".indexOf(c) >= 0) {
                    out.append('\\').append(c);
                } else {
                    out.append(c);
                }
            }
            return out.toString();
        }
    }

    // ---- the real process tree -------------------------------------------------------------

    /** {@link ProcessHandle} for the tree, {@code ps} for the groups it does not expose. */
    private static final class LiveTable implements ProcessTable {
        @Override
        public long self() {
            return ProcessHandle.current().pid();
        }

        @Override
        public Optional<Long> parentOf(long pid) {
            return ProcessHandle.of(pid).flatMap(ProcessHandle::parent).map(ProcessHandle::pid);
        }

        @Override
        public List<Long> childrenOf(long pid) {
            return ProcessHandle.of(pid)
                    .map(handle -> handle.children().map(ProcessHandle::pid).sorted().toList())
                    .orElse(List.of());
        }

        @Override
        public Optional<Proc> describe(long pid) {
            return ProcessHandle.of(pid).map(handle -> {
                ProcessHandle.Info info = handle.info();
                return new Proc(pid, info.command().orElse(null), info.commandLine().orElse(null));
            });
        }

        @Override
        public Map<Long, Long> groupsOf(Collection<Long> pids) {
            Map<Long, Long> groups = new LinkedHashMap<>();
            if (pids.isEmpty()) {
                return groups;
            }
            String list = pids.stream().map(String::valueOf).collect(Collectors.joining(","));
            Process ps = null;
            try {
                ps = new ProcessBuilder("/bin/ps", "-o", "pid=,pgid=", "-p", list)
                        .redirectErrorStream(true).start();
                String output;
                try (InputStream in = ps.getInputStream()) {
                    output = new String(in.readNBytes(1 << 16), StandardCharsets.UTF_8);
                }
                ps.waitFor(2, TimeUnit.SECONDS);
                for (String line : output.split("\n")) {
                    String[] cells = line.strip().split("\\s+");
                    if (cells.length == 2 && NUMBER.matcher(cells[0]).matches()
                            && NUMBER.matcher(cells[1]).matches()) {
                        groups.put(Long.parseLong(cells[0]), Long.parseLong(cells[1]));
                    }
                }
            } catch (IOException failed) {
                log.debug("host guard: ps for process groups failed", failed);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            } finally {
                if (ps != null && ps.isAlive()) {
                    ps.destroyForcibly();
                }
            }
            return groups;
        }
    }
}
