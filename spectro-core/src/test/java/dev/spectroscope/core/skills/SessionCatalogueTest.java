package dev.spectroscope.core.skills;

import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 558, criterion 2: the owner's rule for names across the workspace, the
 * picked playbook and the user's folders (2026-10-12). A name that exists once
 * keeps its plain form; a name that exists more than once is kept in every
 * source, each under a namespace naming its source, the playbook's under the
 * playbook's id. No source wins.
 */
class SessionCatalogueTest {

    private static SessionCatalogue.Entry skill(String plain) {
        return new SessionCatalogue.Entry(SessionCatalogue.SKILL, plain, "about " + plain, "body of " + plain,
                Path.of("/x", plain, "SKILL.md"), null);
    }

    private static SessionCatalogue.Entry command(String plain) {
        return new SessionCatalogue.Entry(SessionCatalogue.COMMAND, plain, "command " + plain, "do " + plain,
                Path.of("/x", "commands", plain + ".md"), null);
    }

    private static SessionCatalogue.Entry agent(String plain, String type) {
        return new SessionCatalogue.Entry(SessionCatalogue.AGENT, plain, "agent " + plain, "You are " + plain,
                Path.of("/x", "agents", plain + ".md"), type);
    }

    private static SessionCatalogue.Layer workspace(SessionCatalogue.Entry... entries) {
        return new SessionCatalogue.Layer(SessionCatalogue.WORKSPACE, SessionCatalogue.WORKSPACE, List.of(entries));
    }

    private static SessionCatalogue.Layer user(SessionCatalogue.Entry... entries) {
        return new SessionCatalogue.Layer(SessionCatalogue.USER, SessionCatalogue.USER, List.of(entries));
    }

    private static SessionCatalogue.Layer playbook(String id, SessionCatalogue.Entry... entries) {
        return new SessionCatalogue.Layer(SessionCatalogue.PLAYBOOK, SessionCatalogue.playbookNamespace(id),
                List.of(entries));
    }

    /** Effective name to source, for every item of the catalogue. */
    private static Map<String, String> names(SessionCatalogue c) {
        return c.items().stream().collect(Collectors.toMap(SessionCatalogue.Item::name, SessionCatalogue.Item::source));
    }

    /**
     * Card 587, fix round (M7): the source words are one closed list, which the
     * web's session items are held to (sessionItems.drift.test.ts). A layer
     * from any other source is refused, so a fifth source has to join the list.
     */
    @Test
    void aLayerComesFromOneOfTheFourSources() {
        assertEquals(List.of(SessionCatalogue.WORKSPACE, SessionCatalogue.PLAYBOOK, SessionCatalogue.USER,
                SessionCatalogue.APP), SessionCatalogue.SOURCES);
        assertThrows(IllegalArgumentException.class,
                () -> new SessionCatalogue.Layer("team", "team", List.of(skill("lint"))));
        for (String source : SessionCatalogue.SOURCES) {
            assertEquals(source, new SessionCatalogue.Layer(source, source, List.of()).source(),
                    "premise: every listed source makes a layer");
        }
    }

    @Test
    void aNameThatExistsOnceKeepsItsPlainForm() {
        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(skill("lint")), playbook("spectro", skill("brainstorming")), user(skill("humanizer"))));

        assertEquals(Map.of("lint", "workspace", "brainstorming", "playbook", "humanizer", "user"), names(c));
    }

    @Test
    void aNameInAllThreeSourcesStaysThreeTimesEachUnderItsSource() {
        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(skill("review")), playbook("spectro", skill("review")), user(skill("review"))));

        assertEquals(Map.of("workspace:review", "workspace", "spectro:review", "playbook", "user:review", "user"),
                names(c));
        assertTrue(c.find("review").isEmpty(), "no source wins the plain name");
        assertEquals("body of review", c.find("spectro:review").orElseThrow().body());
    }

    @Test
    void theOwnersExampleThePlaybooksBrainstormingBesideTheUsersOne() {
        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(), playbook("spectro", skill("brainstorming"), skill("writing-plans")),
                user(skill("brainstorming"), skill("superpowers:brainstorming"))));

        assertEquals(Map.of("spectro:brainstorming", "playbook", "writing-plans", "playbook",
                "user:brainstorming", "user", "superpowers:brainstorming", "user"), names(c));
        SessionCatalogue.Item item = c.find("spectro:brainstorming").orElseThrow();
        assertEquals("brainstorming", item.plain());
        assertEquals("spectro", item.namespace());
    }

    @Test
    void aCommandAndASkillShareTheSlashNameSpace() {
        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(), playbook("team-x", command("review")), user(skill("review"))));

        assertEquals(Map.of("team-x:review", "playbook", "user:review", "user"), names(c));
        assertEquals(SessionCatalogue.COMMAND, c.find("team-x:review").orElseThrow().kind());
    }

    @Test
    void aNamespacedNameThatMeetsAnotherPlainNameIsNamespacedAgainSoEveryNameIsUnique() {
        // The user's pack "workspace" holds a skill "foo", which the pack rule
        // already calls "workspace:foo"; the workspace's own "foo" is doubled by
        // the user's top level "foo" and would become "workspace:foo" too.
        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(skill("foo")), playbook("spectro"), user(skill("foo"), skill("workspace:foo"))));

        List<String> all = c.items().stream().map(SessionCatalogue.Item::name).sorted().toList();
        assertEquals(List.of("user:foo", "user:workspace:foo", "workspace:foo"), all);
        assertEquals(SessionCatalogue.WORKSPACE, c.find("workspace:foo").orElseThrow().source());
    }

    @Test
    void aPlaybookIdThatIsASourceWordGetsANamespaceOfItsOwn() {
        assertEquals("playbook-user", SessionCatalogue.playbookNamespace("user"));
        assertEquals("playbook-workspace", SessionCatalogue.playbookNamespace("workspace"));
        assertEquals("spectro", SessionCatalogue.playbookNamespace("spectro"));

        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(), playbook("user", skill("x")), user(skill("x"))));
        assertEquals(Map.of("playbook-user:x", "playbook", "user:x", "user"), names(c));
    }

    @Test
    void theLibraryHoldsSkillsAndCommandsUnderTheirEffectiveNamesAndAgentsStandApart() {
        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(skill("tdd")), playbook("spectro", skill("tdd"), command("ship"), agent("reviewer", "explore")),
                user()));

        assertEquals(List.of("ship", "spectro:tdd", "workspace:tdd"),
                c.library().skills().stream().map(Skill::name).toList());
        assertEquals("do ship", c.library().find("ship").orElseThrow().body());
        assertEquals(List.of("reviewer"), c.agents().stream().map(SessionCatalogue.Item::name).toList());
        assertEquals("explore", c.agents().getFirst().agentType());
        assertTrue(c.library().find("reviewer").isEmpty(), "an agent is not a slash item");
    }

    /**
     * Integrator decision 5 (card 558): a playbook's slash item named like a
     * built-in chat command is always namespaced, so it never shadows the
     * built-in, even when the name exists once.
     */
    @Test
    void aPlaybookItemNamedLikeABuiltInChatCommandIsAlwaysNamespaced() {
        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(), playbook("team-x", command("clear"), skill("loop"), command("ship")), user(skill("tdd"))),
                java.util.Set.of("clear", "loop", "compact"));

        assertEquals(Map.of("team-x:clear", "playbook", "team-x:loop", "playbook", "ship", "playbook",
                "tdd", "user"), names(c));
        assertEquals("clear", c.find("team-x:clear").orElseThrow().plain());
    }

    /**
     * Integrator decision of round 3 (card 558): the built-in rule covers the
     * workspace's and the user's items too, so such an item stays reachable
     * under its source's namespace and never shadows the built-in.
     */
    @Test
    void aWorkspaceOrUserItemNamedLikeABuiltInIsAlwaysNamespacedToo() {
        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(skill("clear")), playbook("team-x", command("ship")), user(command("loop"), skill("tdd"))),
                java.util.Set.of("clear", "loop", "compact"));

        assertEquals(Map.of("workspace:clear", "workspace", "ship", "playbook", "user:loop", "user", "tdd", "user"),
                names(c));
    }

    /**
     * Owner answer of 2026-10-13 (card 558): only the words of commands the web
     * chat runs force a namespace. An item named like a terminal-only command
     * keeps its plain name, and a doubled one is still namespaced in every
     * source.
     */
    @Test
    void onlyAWebCommandsWordForcesANamespaceAndTheDoubledRuleStays() {
        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(command("model"), skill("goal"), command("clear"), skill("cost")),
                playbook("team-x", command("think")),
                user(skill("cost"), command("compact"))),
                dev.spectroscope.core.commands.CommandList.webFirstWords());

        assertEquals(Map.of("model", "workspace", "goal", "workspace", "workspace:clear", "workspace",
                "workspace:cost", "workspace", "think", "playbook", "user:cost", "user",
                "user:compact", "user"), names(c));
    }

    /**
     * Review finding 2 (card 558): a skill and a command of one source with one
     * name both stay; the skill keeps the plain name, the command takes its
     * source's namespace.
     */
    @Test
    void aSkillAndACommandOfOneSourceWithOneNameBothStay() {
        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(skill("review"), command("review")), playbook("team-x", skill("ship"), command("ship")),
                user()));

        assertEquals(Map.of("review", "workspace", "workspace:review", "workspace", "ship", "playbook",
                "team-x:ship", "playbook"), names(c));
        assertEquals(SessionCatalogue.SKILL, c.find("review").orElseThrow().kind());
        assertEquals(SessionCatalogue.COMMAND, c.find("workspace:review").orElseThrow().kind());
    }

    /** The same pair doubled by another source: all three stay, the command under its kind as well. */
    @Test
    void aSkillAndACommandOfOneSourceDoubledElsewhereStayUnique() {
        SessionCatalogue c = SessionCatalogue.of(List.of(
                workspace(skill("review"), command("review")), playbook("team-x"), user(skill("review"))));

        assertEquals(Map.of("workspace:review", "workspace", "workspace:command:review", "workspace",
                "user:review", "user"), names(c));
        assertEquals(SessionCatalogue.COMMAND, c.find("workspace:command:review").orElseThrow().kind());
    }

    /** Card 587: the skills the app itself ships are a fourth source, under the same rule. */
    @Test
    void theAppsOwnSkillIsAFourthSourceUnderTheSameRule() {
        SessionCatalogue.Layer app = new SessionCatalogue.Layer(SessionCatalogue.APP, SessionCatalogue.APP,
                List.of(skill("code-graph")));
        SessionCatalogue alone = SessionCatalogue.of(List.of(workspace(), user(skill("x")), app));
        assertEquals(Map.of("x", "user", "code-graph", "app"), names(alone));

        SessionCatalogue doubled = SessionCatalogue.of(List.of(workspace(skill("code-graph")), user(), app));
        assertEquals(Map.of("workspace:code-graph", "workspace", "app:code-graph", "app"), names(doubled),
                "no source wins, the app's included");
        assertEquals("playbook-app", SessionCatalogue.playbookNamespace("app"));
    }

    @Test
    void anEmptyCatalogueHasNoItems() {
        SessionCatalogue c = SessionCatalogue.of(List.of());
        assertTrue(c.items().isEmpty());
        assertTrue(c.library().skills().isEmpty());
        assertTrue(c.agents().isEmpty());
    }

    @Test
    void aLayerReadFromALibraryKeepsTheLibrarysNames() {
        Skill packed = new Skill("superpowers:tdd", "d", "b", Path.of("/u/superpowers/tdd/SKILL.md"));
        Skill top = new Skill("tdd", "d2", "b2", Path.of("/u/tdd/SKILL.md"));
        SessionCatalogue.Layer layer = SessionCatalogue.Layer.ofSkills(SessionCatalogue.USER, List.of(packed, top));

        assertEquals(List.of("superpowers:tdd", "tdd"), layer.entries().stream().map(SessionCatalogue.Entry::plain).toList());
        assertEquals(SessionCatalogue.USER, layer.namespace());
    }
}
