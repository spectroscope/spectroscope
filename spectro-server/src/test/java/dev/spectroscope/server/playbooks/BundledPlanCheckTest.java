package dev.spectroscope.server.playbooks;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.spectroscope.core.Asker;
import dev.spectroscope.core.CancelSignal;
import dev.spectroscope.core.PermissionBroker;
import dev.spectroscope.core.events.RunEvent;
import dev.spectroscope.core.playbook.Playbook;
import dev.spectroscope.core.playbook.PlaybookReader;
import dev.spectroscope.core.playbook.run.CheckResult;
import dev.spectroscope.core.playbook.run.DocumentChecks;
import dev.spectroscope.core.playbook.run.PinnedPlaybook;
import dev.spectroscope.core.playbook.run.PlaybookHost;
import dev.spectroscope.core.playbook.run.PlaybookRecorder;
import dev.spectroscope.core.playbook.run.PlaybookRunner;
import dev.spectroscope.core.playbook.run.Probe;
import dev.spectroscope.core.playbook.run.RunStop;
import dev.spectroscope.core.provider.LlmProvider;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 596: the bundled plan check and the bundled planning skill agree. The
 * skill says every plan starts with its header, and the header writes the
 * plan's first sections as bold fields such as {@code **Goal:**}. The check
 * {@code plan_sections} of the decision {@code plan_ok} used to count headings
 * only, so a run that followed the skill failed the plan three times and ended
 * cancelled. Every test here reads the real bundle: {@code playbook.json}, the
 * header block of {@code writing-plans/SKILL.md} and {@code templates/plan.md}.
 */
class BundledPlanCheckTest {

    static final String BUNDLE = "bundled-playbooks/spectro/";
    static final Pattern FIELD = Pattern.compile("^\\*\\*([^*]+?)(?::\\*\\*|\\*\\*:)");
    static final Pattern HEADING = Pattern.compile("^#{1,6}\\s+(.+?)\\s*$");
    static final Pattern STEP_ID = Pattern.compile("\\(([a-z0-9_-]+)\\)\\.");
    static final ObjectMapper JSON = new ObjectMapper();

    @TempDir Path tmp;

    static String resource(String path) throws IOException {
        return new ClassPathResource(BUNDLE + path).getContentAsString(StandardCharsets.UTF_8);
    }

    static Playbook playbook(String json) {
        PlaybookReader.Read read = PlaybookReader.read(json);
        assertEquals(List.of(), read.findings());
        return read.playbook();
    }

    static Playbook.Check checkOf(Playbook p, String decisionId) {
        for (Playbook.Node n : p.nodes()) {
            if (n instanceof Playbook.Decision d && d.id().equals(decisionId)) {
                return p.checks().get(d.check());
            }
        }
        throw new AssertionError("the bundled playbook has no decision " + decisionId);
    }

    /** The one document the check of plan_ok reads. */
    static String planId(Playbook p) {
        Playbook.Check c = checkOf(p, "plan_ok");
        assertEquals("sections", c.kind(), "plan_ok no longer runs a sections check");
        assertEquals(1, c.documents().size(), c.documents().toString());
        return c.documents().get(0);
    }

    /** The markdown block the skill shows under its heading "Plan Document Header", as the skill prescribes it. */
    static String skillHeader() throws IOException {
        String skill = resource("skills/spectropowers/writing-plans/SKILL.md");
        int section = skill.indexOf("\n## Plan Document Header\n");
        assertTrue(section >= 0, "the skill has no section Plan Document Header");
        String fence = "```markdown\n";
        int open = skill.indexOf(fence, section);
        assertTrue(open >= 0, "the header section shows no markdown block");
        int close = skill.indexOf("\n```", open + fence.length());
        assertTrue(close >= 0, "the header block is never closed");
        return skill.substring(open + fence.length(), close + 1);
    }

    /** The names of the lines of a text that start with a bold field, in order. */
    static List<String> fields(String text) {
        List<String> out = new ArrayList<>();
        for (String line : text.split("\n", -1)) {
            Matcher m = FIELD.matcher(line);
            if (m.find()) {
                out.add(m.group(1).strip());
            }
        }
        return out;
    }

    static List<String> headings(String text) {
        List<String> out = new ArrayList<>();
        for (String line : text.split("\n", -1)) {
            Matcher m = HEADING.matcher(line);
            if (m.matches()) {
                out.add(m.group(1).strip());
            }
        }
        return out;
    }

    static boolean carries(List<String> names, String section) {
        return names.stream().anyMatch(n -> n.equalsIgnoreCase(section));
    }

    /**
     * A plan written the way the skill says: the skill's header, then every
     * section of the plan template that the header does not carry, in
     * template order, with the template's text under it.
     */
    static String skillShapedPlan(Playbook p) throws IOException {
        String header = skillHeader();
        List<String> carried = new ArrayList<>(fields(header));
        carried.addAll(headings(header));
        String template = resource(p.documents().get(planId(p)).template());
        StringBuilder plan = new StringBuilder(header);
        boolean keep = false;
        for (String line : template.split("\n", -1)) {
            if (line.startsWith("## ")) {
                keep = !carries(carried, line.substring(3).strip());
            }
            if (keep) {
                plan.append('\n').append(line);
            }
        }
        return plan.append('\n').toString();
    }

    /** The bold fields of the skill's header that name a section of the plan, in header order. */
    static List<String> headerFieldsThePlanNeeds(Playbook p) throws IOException {
        List<String> sections = p.documents().get(planId(p)).sections();
        return fields(skillHeader()).stream().filter(f -> carries(sections, f)).toList();
    }

    /** The check of plan_ok on a plan text, with the arguments the runner passes for one document. */
    CheckResult planOk(Playbook p, String plan) throws IOException {
        String id = planId(p);
        Path file = Files.writeString(tmp.resolve("plan.md"), plan);
        return DocumentChecks.sections(id, file, p.documents().get(id).sections(), checkOf(p, "plan_ok").forbid());
    }

    @Test
    void thePlanCheckPassesAPlanThatStartsWithTheSkillsHeader() throws IOException {
        Playbook p = playbook(resource("playbook.json"));
        String plan = skillShapedPlan(p);
        CheckResult r = planOk(p, plan);
        assertEquals("pass", r.label(), r.detail() + "\n" + plan);
    }

    @Test
    void thePlanTemplateWithItsHeadingsStillPassesThePlanCheck() throws IOException {
        Playbook p = playbook(resource("playbook.json"));
        String template = resource(p.documents().get(planId(p)).template());
        List<String> sections = p.documents().get(planId(p)).sections();
        assertEquals(List.of(), fields(template).stream().filter(f -> carries(sections, f)).toList(),
                "the template writes no section as a bold field");
        CheckResult r = planOk(p, template);
        assertEquals("pass", r.label(), r.detail());
    }

    /** Card 596 review I2: a field the skill renames must not be covered by the template's heading. */
    @Test
    void everyBoldFieldOfTheSkillsHeaderNamesASectionOfThePlan() throws IOException {
        Playbook p = playbook(resource("playbook.json"));
        List<String> sections = p.documents().get(planId(p)).sections();
        List<String> fields = fields(skillHeader());
        assertFalse(fields.isEmpty(), "the skill's header carries no bold field");
        assertEquals(List.of(), fields.stream().filter(f -> !carries(sections, f)).toList(),
                "bold fields of the skill's header that name no section of the plan " + sections);
    }

    /** Card 596 review I1: a section with sub-headings may be a bold field too. */
    @Test
    void thePlanTemplateWithEverySectionAsABoldFieldPassesThePlanCheck() throws IOException {
        Playbook p = playbook(resource("playbook.json"));
        List<String> sections = p.documents().get(planId(p)).sections();
        StringBuilder plan = new StringBuilder();
        int turned = 0;
        for (String line : resource(p.documents().get(planId(p)).template()).split("\n", -1)) {
            if (line.startsWith("## ") && carries(sections, line.substring(3).strip())) {
                plan.append("**").append(line.substring(3).strip()).append(":**\n");
                turned++;
            } else {
                plan.append(line).append('\n');
            }
        }
        assertEquals(sections.size(), turned, plan.toString());
        assertTrue(plan.toString().contains("\n### "), "the template's Tasks section holds sub-headings");
        CheckResult r = planOk(p, plan.toString());
        assertEquals("pass", r.label(), r.detail() + "\n" + plan);
    }

    @Test
    void withoutOneOfTheHeadersFieldsThePlanCheckFailsAndNamesIt() throws IOException {
        Playbook p = playbook(resource("playbook.json"));
        List<String> wanted = headerFieldsThePlanNeeds(p);
        assertFalse(wanted.isEmpty(), "the skill's header carries no bold field the plan check needs,"
                + " so this test no longer reaches the bold field rule");
        String plan = skillShapedPlan(p);
        for (String field : wanted) {
            CheckResult r = planOk(p, withoutField(plan, field));
            assertEquals("fail", r.label(), field);
            assertTrue(r.detail().startsWith(planId(p) + ": missing section " + field + " ("), r.detail());
            assertTrue(r.detail().contains("\"**" + field + ":**\""), r.detail());
        }
    }

    /** The plan without the paragraph that the field opens: its line and the lines after it up to a blank one. */
    static String withoutField(String plan, String field) {
        StringBuilder out = new StringBuilder();
        boolean skipping = false;
        boolean dropped = false;
        for (String line : plan.split("\n", -1)) {
            Matcher m = FIELD.matcher(line);
            if (m.find() && m.group(1).strip().equalsIgnoreCase(field)) {
                skipping = true;
                dropped = true;
                continue;
            }
            if (skipping && !line.isBlank()) {
                continue;
            }
            skipping = false;
            out.append(line).append('\n');
        }
        assertTrue(dropped, "the plan has no field " + field);
        return out.toString();
    }

    /**
     * The scenario of the card: the real bundle copied into a folder and run
     * on the real runner, with a host whose brainstorm step writes the spec
     * template and whose plan step writes the skill shaped plan. The person
     * answers the path question and the spec nod and leaves the plan nod
     * unanswered, so the run stops there.
     */
    @Test
    void aRunOfTheBundledPlaybookPassesPlanOkOnTheFirstPlanAndGoesOnToThePlanNod() throws IOException {
        Path dir = tmp.resolve("spectro");
        Map<String, Resource> files = new PlaybookController(new PlaybookFolders(tmp.resolve("playbooks.json")),
                PlaybookController.BUNDLE_ROOT).bundled("spectro");
        for (Map.Entry<String, Resource> f : files.entrySet()) {
            Path target = dir.resolve(f.getKey());
            Files.createDirectories(target.getParent());
            try (InputStream in = f.getValue().getInputStream()) {
                Files.copy(in, target);
            }
        }
        Playbook p = playbook(Files.readString(dir.resolve("playbook.json")));
        Map<String, String> texts = new java.util.HashMap<>();
        for (Map.Entry<String, Playbook.DocumentType> d : p.documents().entrySet()) {
            texts.put(d.getKey(), d.getKey().equals(planId(p)) ? skillShapedPlan(p) : resource(d.getValue().template()));
        }
        Host host = new Host(Files.createDirectories(tmp.resolve("ws")), p, texts);
        String toBrainstorm = labelTo(p, "classify", "brainstorm");
        String toPlan = labelTo(p, "spec_nod", "write_plan");
        host.answers.put(checkOf(p, "classify").ask(), toBrainstorm);
        host.answers.put(checkOf(p, "spec_nod").ask(), toPlan);
        String planNod = checkOf(p, "plan_nod").ask();
        assertFalse(host.answers.containsKey(planNod));

        Path sidecar = tmp.resolve("s1.playbook.jsonl");
        PlaybookRunner.Setup setup = new PlaybookRunner.Setup(PinnedPlaybook.pin(dir, p), "abcdefabcdef",
                tmp.resolve("s1.abcdefabcdef.graph.jsonl"),
                new PlaybookRecorder(sidecar, PlaybookRecorder.DEFAULT_CEILING_BYTES), new CancelSignal(), "auto");
        PlaybookRunner.Outcome out = new PlaybookRunner(setup, host, null, command -> Optional.empty()).run();

        List<String> checks = new ArrayList<>();
        List<String> details = new ArrayList<>();
        for (String line : Files.readAllLines(sidecar)) {
            JsonNode n = JSON.readTree(line);
            if ("check".equals(n.get("type").asText())) {
                checks.add(n.get("node").asText() + " " + n.get("label").asText());
                details.add(n.get("node").asText() + ": " + n.get("detail").asText());
            }
        }
        assertEquals(List.of("classify " + toBrainstorm, "spec_ok pass", "spec_nod " + toPlan, "plan_ok pass",
                "plan_nod null"), checks, details.toString());
        assertEquals(List.of("brainstorm", "write_plan"), host.turns, "the plan was written once");
        assertEquals(RunStop.UNANSWERED, out.stopReason(), String.valueOf(out));
        assertEquals("plan_nod: no answer", out.detail());
        assertEquals(planNod, host.asked.get(host.asked.size() - 1), "the last question is the plan nod");

        String first = p.documents().get(planId(p)).sections().get(0);
        String writePlan = host.records.get(1);
        assertTrue(writePlan.contains("\"## " + first + "\"") && writePlan.contains("\"**" + first + ":**\""),
                "the plan step's Done when line names both forms: " + writePlan);
    }

    /** The label of the arrow that leads from a decision to a node. */
    static String labelTo(Playbook p, String from, String to) {
        return p.arrows().stream().filter(a -> a.from().equals(from) && a.to().equals(to)).map(Playbook.Arrow::on)
                .findFirst().orElseThrow(() -> new AssertionError("no arrow from " + from + " to " + to));
    }

    /** A host without a server: each chat step writes the documents it produces, nothing else is reached. */
    static final class Host implements PlaybookHost {

        final Path workspace;
        final Playbook playbook;
        final Map<String, String> texts;
        final Map<String, String> answers = new java.util.HashMap<>();
        final List<String> turns = new CopyOnWriteArrayList<>();
        final List<String> records = new CopyOnWriteArrayList<>();
        final List<String> asked = new CopyOnWriteArrayList<>();
        final List<RunEvent> events = new CopyOnWriteArrayList<>();
        Playbook.ModelRef chat = new Playbook.ModelRef("lmstudio", "start-model");

        Host(Path workspace, Playbook playbook, Map<String, String> texts) {
            this.workspace = workspace;
            this.playbook = playbook;
            this.texts = texts;
        }

        @Override public Path workspace() { return workspace; }

        @Override public void emit(RunEvent event) { events.add(event); }

        @Override
        public ChatTurn chatTurn(String recordPrompt, String modelPrompt, CancelSignal signal) {
            Matcher m = STEP_ID.matcher(recordPrompt);
            assertTrue(m.find(), recordPrompt);
            String id = m.group(1);
            turns.add(id);
            records.add(recordPrompt);
            Playbook.Step step = playbook.nodes().stream().filter(n -> n instanceof Playbook.Step && n.id().equals(id))
                    .map(Playbook.Step.class::cast).findFirst().orElseThrow();
            for (String doc : step.produces()) {
                String text = texts.get(doc);
                assertTrue(text != null, "the step " + id + " produces " + doc + ", which this test does not write");
                String rel = playbook.documents().get(doc).location()
                        .replace("{date}", "2026-10-13").replace("{slug}", "plan-check");
                try {
                    Path f = workspace.resolve(rel);
                    Files.createDirectories(f.getParent());
                    Files.writeString(f, text);
                } catch (IOException e) {
                    throw new IllegalStateException(e);
                }
            }
            return new ChatTurn("end_turn", "written");
        }

        @Override public Playbook.ModelRef chatModel() { return chat; }

        @Override
        public String switchChat(Playbook.ModelRef ref) {
            chat = ref;
            return null;
        }

        @Override
        public LlmProvider providerFor(Playbook.ModelRef ref) {
            throw new IllegalStateException("this run reaches no child step and no review");
        }

        @Override
        public Probe probe(String provider) {
            return new Probe(provider, kindOf(provider), "reachable", null, null, List.of(), false, 1L);
        }

        @Override
        public String kindOf(String provider) {
            return switch (provider) {
                case "anthropic" -> "cloud";
                case "ollama", "lmstudio" -> "local";
                default -> throw new IllegalStateException("the bundled playbook names no provider " + provider);
            };
        }

        @Override public void permissionFloor(String mode) { }

        @Override public PermissionBroker broker() { return request -> false; }

        @Override
        public Asker asker() {
            return question -> {
                String text = question.questions().get(0).question();
                asked.add(text);
                String answer = answers.get(text);
                return answer == null ? null : new Asker.Answer(List.of(answer));
            };
        }
    }
}
