package dev.spectroscope.core.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.provider.LlmProvider.ProviderContent;
import dev.spectroscope.core.provider.LlmProvider.ProviderMessage;
import dev.spectroscope.core.provider.LlmProvider.TextContent;
import dev.spectroscope.core.provider.LlmProvider.ToolCallContent;
import dev.spectroscope.core.provider.LlmProvider.ToolResultContent;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Predicate;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Card 467, criterion 2: the census that picked {@link ToolResultElision#KEEP_TURNS}
 * and {@link ToolResultElision#MIN_RESULT_CHARS}.
 *
 * <p>Runs only when asked, because it reads the operator's own session store,
 * which a test JVM never sees (user.home is redirected for every test):</p>
 *
 * <pre>./gradlew :spectro-core:test --tests '*ToolResultElisionCensus' --rerun-tasks \
 *     --no-build-cache -Delision.census.home=$HOME/.spectro -Delision.census.out=&lt;dir&gt;</pre>
 *
 * <p><b>Method.</b> Every {@code .jsonl} under {@code sessions/} and each
 * {@code sessions-archive-*} folder (blob folders skipped) is folded into the
 * main agent's history by {@link SessionStore#historyOf}, the fold a resume
 * uses. Each assistant message in that history was produced by one request,
 * and that request carried every message before it, so the census replays the
 * history prefix by prefix through ONE {@link ToolResultElision} per session,
 * the way the agent asks it once per turn, and counts the chars of each
 * request twice: as the history stands, and as the elision sends it. Chars are
 * text, tool-call name plus input JSON, and tool-result output; images are left
 * out of both sides. Child agents' requests are not counted (the fold keeps
 * the main agent).</p>
 *
 * <p><b>Compaction.</b> The resume fold rebuilds the whole history and knows
 * nothing of compaction, so a session that compacted would replay requests
 * nobody sent. The census applies each recorded main-agent {@code compaction}
 * event where it happened instead: the history folded up to that event loses
 * its first {@code removedTurns} messages (the cut repaired the way
 * {@link Compaction} repairs it) to a summary of {@code summaryChars} chars,
 * and later requests build on that. The compaction points are the recorded
 * ones, from runs without elision. With elision on, compaction would fire
 * later, so the replay counts fewer summarizer calls and smaller requests
 * between the recorded point and the later one than a run would have.</p>
 */
class ToolResultElisionCensus {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** The tools whose result cannot be had again by calling them, asked of
     *  the shipped tools themselves rather than typed here. */
    private static final Set<String> NOT_REPEATABLE = notRepeatable();

    private static Set<String> notRepeatable() {
        dev.spectroscope.core.subagents.SubagentManager manager =
                new dev.spectroscope.core.subagents.SubagentManager(
                        dev.spectroscope.core.subagents.SubagentConfig.builder()
                                .cwd(Path.of(".")).parentAgentId("main")
                                .onPermission(request -> true).baseTools(List.of()).build());
        List<dev.spectroscope.core.tools.Tool> shipped = new ArrayList<>();
        shipped.addAll(dev.spectroscope.core.tools.StandardTools.all());
        shipped.addAll(manager.tools());
        shipped.addAll(manager.devTools());
        shipped.add(new dev.spectroscope.core.tools.AskUserQuestionTool(request -> null));
        shipped.add(new dev.spectroscope.core.image.GenerateImageTool(() -> null,
                new dev.spectroscope.core.image.ImageStore(Path.of("."))));
        Set<String> names = new java.util.TreeSet<>();
        for (dev.spectroscope.core.tools.Tool tool : shipped) {
            if (!tool.resultRepeatable()) {
                names.add(tool.name());
            }
        }
        return Set.copyOf(names);
    }

    private static final int[] KEEP = {4, 6, 8};
    private static final int[] MIN = {1_000, 2_000, 4_000};

    /**
     * One session's requests with its file: one request per assistant message,
     * each holding the history it was produced from, compacted where the
     * session compacted.
     */
    private record Recorded(Path file, List<List<ProviderMessage>> requests, int compactions,
                            long recordedTokens, long recordedTurns) {
    }

    /** What one rule did over every session. */
    private record Tally(long requests, long charsOff, long charsOn, long batches,
                         long sessionsChanged) {
    }

    @Test
    void census() throws IOException {
        String home = System.getProperty("elision.census.home");
        String out = System.getProperty("elision.census.out");
        assumeTrue(home != null && out != null, "census not requested");

        List<Recorded> sessions = read(Path.of(home));
        StringBuilder report = new StringBuilder();
        report.append("# Card 467 census: chars per request with tool-result elision\n\n");
        report.append("Session files read: ").append(sessions.size()).append('\n');
        long requests = sessions.stream().mapToLong(s -> s.requests().size()).sum();
        report.append("Requests replayed (main agent, one per assistant message): ")
                .append(requests).append('\n');
        report.append("Recorded main-agent compactions applied: ")
                .append(sessions.stream().mapToInt(Recorded::compactions).sum()).append(" in ")
                .append(sessions.stream().filter(s -> s.compactions() > 0).count())
                .append(" sessions\n");
        report.append("Batch: ").append(ToolResultElision.BATCH_CHARS).append(" chars\n\n");
        report.append("| K (turns kept) | N (min chars) | requests | mean chars/request off"
                + " | mean chars/request on | mean saved/request | saved % | batches"
                + " | sessions changed |\n");
        report.append("|---|---|---|---|---|---|---|---|---|\n");
        Predicate<String> repeatable = name -> !NOT_REPEATABLE.contains(name);
        for (int keep : KEEP) {
            for (int min : MIN) {
                Tally tally = tally(sessions, () -> new ToolResultElision(true, repeatable, keep, min,
                        ToolResultElision.BATCH_CHARS));
                report.append(String.format(Locale.ROOT,
                        "| %d | %,d | %,d | %,.0f | %,.0f | %,.0f | %.1f | %,d | %,d |%n",
                        keep, min, tally.requests(),
                        (double) tally.charsOff() / tally.requests(),
                        (double) tally.charsOn() / tally.requests(),
                        (double) (tally.charsOff() - tally.charsOn()) / tally.requests(),
                        100.0 * (tally.charsOff() - tally.charsOn()) / tally.charsOff(),
                        tally.batches(), tally.sessionsChanged()));
            }
        }

        // The pooled mean above is dominated by the longest sessions. The same
        // grid, every session weighted once and without the single largest
        // session, says whether the ranking survives that.
        Recorded largest = sessions.stream()
                .max(java.util.Comparator.comparingLong(s -> s.requests().size()))
                .orElseThrow();
        List<Recorded> rest = sessions.stream().filter(s -> s != largest).toList();
        report.append("\n## The same grid, two other weightings\n\n");
        report.append("Largest session left out: ").append(Path.of(home).relativize(largest.file()))
                .append(" (").append(largest.requests().size()).append(" requests).\n");
        report.append("Per-session mean: the saved % of each session that has at least one request,"
                + " averaged with every session weighted once.\n\n");
        report.append("| K | N | saved % without the largest | mean chars saved/request without it"
                + " | per-session mean saved % | batches without it |\n");
        report.append("|---|---|---|---|---|---|\n");
        for (int keep : KEEP) {
            for (int min : MIN) {
                java.util.function.Supplier<ToolResultElision> rule =
                        () -> new ToolResultElision(true, repeatable, keep, min,
                                ToolResultElision.BATCH_CHARS);
                Tally without = tally(rest, rule);
                double perSession = 0;
                int counted = 0;
                for (Recorded session : sessions) {
                    Tally one = tally(List.of(session), rule);
                    if (one.charsOff() > 0) {
                        perSession += 100.0 * (one.charsOff() - one.charsOn()) / one.charsOff();
                        counted++;
                    }
                }
                report.append(String.format(Locale.ROOT, "| %d | %,d | %.1f | %,.0f | %.2f | %,d |%n",
                        keep, min,
                        100.0 * (without.charsOff() - without.charsOn()) / without.charsOff(),
                        (double) (without.charsOff() - without.charsOn()) / without.requests(),
                        perSession / counted, without.batches()));
            }
        }

        report.append("\n## Results the exclusion keeps whole\n\n");
        Tally all = tally(sessions, () -> new ToolResultElision(true, name -> true,
                ToolResultElision.KEEP_TURNS, ToolResultElision.MIN_RESULT_CHARS,
                ToolResultElision.BATCH_CHARS));
        Tally shipped = tally(sessions, () -> new ToolResultElision(true, repeatable));
        report.append(String.format(Locale.ROOT,
                "At the shipped K=%d, N=%,d: saved %,d chars with every tool elidable, %,d with"
                        + " %s kept whole.%n",
                ToolResultElision.KEEP_TURNS, ToolResultElision.MIN_RESULT_CHARS,
                all.charsOff() - all.charsOn(), shipped.charsOff() - shipped.charsOn(),
                new java.util.TreeSet<>(NOT_REPEATABLE)));

        report.append("\n## Long sessions at the shipped rule (at least 15 requests)\n\n");
        report.append("The last two columns check the replay against the session's own usage"
                + " events: the mean context the backend reported per main-agent usage event"
                + " (input plus cache tokens, which also count system prompt and tool schemas),"
                + " and the replayed mean request off divided by four.\n\n");
        report.append("| file | requests | compactions | chars sent across the run, off | on | saved %"
                + " | recorded tokens/request | replayed off chars/4 per request |\n");
        report.append("|---|---|---|---|---|---|---|---|\n");
        List<Recorded> longOnes = new ArrayList<>(sessions.stream()
                .filter(s -> s.requests().size() >= 15).toList());
        longOnes.sort((a, b) -> Integer.compare(b.requests().size(), a.requests().size()));
        for (Recorded session : longOnes) {
            Tally one = tally(List.of(session), () -> new ToolResultElision(true, repeatable));
            report.append(String.format(Locale.ROOT, "| %s | %d | %d | %,d | %,d | %.1f | %s | %,d |%n",
                    Path.of(home).relativize(session.file()), one.requests(), session.compactions(),
                    one.charsOff(), one.charsOn(),
                    100.0 * (one.charsOff() - one.charsOn()) / one.charsOff(),
                    session.recordedTurns() == 0 ? "none"
                            : String.format(Locale.ROOT, "%,d",
                                    session.recordedTokens() / session.recordedTurns()),
                    one.charsOff() / 4 / one.requests()));
        }

        Path target = Path.of(out);
        Files.createDirectories(target);
        Files.writeString(target.resolve("census.md"), report.toString(), StandardCharsets.UTF_8);
    }

    /** Replays every session through a fresh elision per session. */
    private static Tally tally(List<Recorded> sessions,
                               java.util.function.Supplier<ToolResultElision> rule) {
        long requests = 0;
        long off = 0;
        long on = 0;
        long batches = 0;
        long changed = 0;
        for (Recorded session : sessions) {
            ToolResultElision elision = rule.get();
            long previousStubs = 0;
            boolean any = false;
            for (List<ProviderMessage> prefix : session.requests()) {
                List<ProviderMessage> sent = elision.requestView(prefix);
                long full = chars(prefix);
                long cut = chars(sent);
                requests++;
                off += full;
                on += cut;
                long stubs = stubs(prefix, sent);
                if (stubs > previousStubs) {
                    batches++;
                }
                previousStubs = stubs;
                any |= cut < full;
            }
            if (any) {
                changed++;
            }
        }
        return new Tally(requests, off, on, batches, changed);
    }

    /** How many tool results the request carries in a different form than the history. */
    private static long stubs(List<ProviderMessage> history, List<ProviderMessage> sent) {
        long count = 0;
        for (int m = 0; m < history.size(); m++) {
            List<ProviderContent> a = history.get(m).content();
            List<ProviderContent> b = sent.get(m).content();
            for (int c = 0; c < a.size(); c++) {
                if (a.get(c) instanceof ToolResultContent && !a.get(c).equals(b.get(c))) {
                    count++;
                }
            }
        }
        return count;
    }

    private static long chars(List<ProviderMessage> messages) {
        long total = 0;
        for (ProviderMessage message : messages) {
            for (ProviderContent content : message.content()) {
                total += switch (content) {
                    case TextContent text -> text.text().length();
                    case ToolCallContent call -> call.name().length()
                            + (call.input() == null ? 0 : call.input().toString().length());
                    case ToolResultContent result -> result.output().length();
                    default -> 0;
                };
            }
        }
        return total;
    }

    /**
     * The requests one session sent: the history before each assistant
     * message, with every recorded main-agent compaction applied where it
     * happened.
     */
    private static Recorded replay(Path file, List<RunEvent> events) {
        List<ProviderMessage> history = SessionStore.historyOf(events);
        List<Integer> starts = new ArrayList<>();
        List<List<ProviderMessage>> bases = new ArrayList<>();
        starts.add(0);
        bases.add(List.of());
        int compactions = 0;
        long recordedTokens = 0;
        long recordedTurns = 0;
        for (int i = 0; i < events.size(); i++) {
            if (events.get(i) instanceof RunEvent.Usage usage && "main".equals(usage.agentId())) {
                recordedTokens += usage.inputTokens()
                        + (usage.cacheReadTokens() == null ? 0 : usage.cacheReadTokens())
                        + (usage.cacheCreationTokens() == null ? 0 : usage.cacheCreationTokens());
                recordedTurns++;
            }
            if (!(events.get(i) instanceof RunEvent.Compaction compaction)
                    || !"main".equals(compaction.agentId())) {
                continue;
            }
            int at = Math.min(SessionStore.historyOf(events.subList(0, i)).size(), history.size());
            int from = starts.getLast();
            if (at < from) {
                continue;
            }
            List<ProviderMessage> before = new ArrayList<>(bases.getLast());
            before.addAll(history.subList(from, at));
            bases.add(compacted(before, compaction.removedTurns(), compaction.summaryChars()));
            starts.add(at);
            compactions++;
        }
        List<List<ProviderMessage>> requests = new ArrayList<>();
        int segment = 0;
        for (int m = 0; m < history.size(); m++) {
            while (segment + 1 < starts.size() && starts.get(segment + 1) <= m) {
                segment++;
            }
            if (history.get(m).role() != ProviderMessage.Role.ASSISTANT) {
                continue;
            }
            List<ProviderMessage> request = new ArrayList<>(bases.get(segment));
            request.addAll(history.subList(starts.get(segment), m));
            requests.add(List.copyOf(request));
        }
        return new Recorded(file, requests, compactions, recordedTokens, recordedTurns);
    }

    /** One recorded compaction, applied the way {@link Compaction} applies it. */
    private static List<ProviderMessage> compacted(List<ProviderMessage> history, int removed,
                                                   int summaryChars) {
        int cut = Math.max(0, Math.min(removed, history.size()));
        List<ProviderMessage> recent = new ArrayList<>(history.subList(cut, history.size()));
        while (!recent.isEmpty() && recent.getFirst().role() == ProviderMessage.Role.USER
                && recent.getFirst().content().stream().anyMatch(ToolResultContent.class::isInstance)) {
            recent.removeFirst();
        }
        List<ProviderMessage> out = new ArrayList<>();
        out.add(new ProviderMessage(ProviderMessage.Role.USER, List.of(new TextContent(
                "[Summary of the conversation so far]\n\n" + "s".repeat(Math.max(0, summaryChars))))));
        out.addAll(recent);
        return SessionStore.mergeAdjacentRoles(out);
    }

    /** Every session file under sessions/ and sessions-archive-*, blob folders skipped. */
    private static List<Recorded> read(Path home) throws IOException {
        List<Path> roots = new ArrayList<>();
        roots.add(home.resolve("sessions"));
        try (Stream<Path> top = Files.list(home)) {
            top.filter(p -> p.getFileName().toString().startsWith("sessions-archive-"))
                    .filter(Files::isDirectory).sorted().forEach(roots::add);
        }
        List<Path> files = new ArrayList<>();
        for (Path root : roots) {
            try (Stream<Path> walk = Files.walk(root)) {
                walk.filter(p -> p.toString().endsWith(".jsonl"))
                        .filter(p -> !p.toString().endsWith(".llm.jsonl")
                                && !p.toString().endsWith(".graph.jsonl")
                                && !p.toString().endsWith(".state.jsonl"))
                        .filter(p -> !home.relativize(p).toString().contains("/blobs/"))
                        .sorted().forEach(files::add);
            }
        }
        List<Recorded> out = new ArrayList<>();
        for (Path file : files) {
            List<RunEvent> events = new ArrayList<>();
            for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                if (line.isBlank()) {
                    continue;
                }
                try {
                    events.add(JSON.readValue(line, RunEvent.class));
                } catch (IOException unreadable) {
                    // A torn or foreign line: skipped, as readSessionEvents skips it.
                }
            }
            out.add(replay(file, events));
        }
        return out;
    }
}
