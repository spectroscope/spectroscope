package dev.spectroscope.core.session;

import dev.spectroscope.core.config.SpectroConfig;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Card 492: the care paragraph's text is the concept's text without the clause
 * that names the backend, the helper count is filled in, and the subagent
 * sentence goes when no spawn tool is offered. The expected strings are typed
 * in {@link CareTexts}, not read from the class under test.
 */
class CareParagraphTest {

    @Test
    void theConceptsTwoTextsHaveTheConceptsLengths() {
        assertEquals(368, CareTexts.CONCEPT_TWO_HELPERS.length(), "premise: the typed copy is the concept's 368");
        assertEquals(306, CareTexts.CONCEPT_NO_SUBAGENTS.length(), "premise: the typed copy is the concept's 306");
    }

    @Test
    void theShippedTextIsTheConceptsWithoutTheClauseThatNamesTheBackend() {
        assertEquals(CareTexts.CONCEPT_TWO_HELPERS.replace(" on a local model", ""), CareTexts.TWO_HELPERS);
        assertEquals(CareTexts.CONCEPT_NO_SUBAGENTS.replace(" on a local model", ""), CareTexts.NO_SUBAGENTS);
        assertEquals(351, CareTexts.TWO_HELPERS.length());
        assertEquals(289, CareTexts.NO_SUBAGENTS.length());
    }

    @Test
    void theTextNamesNoBackendBecauseTheKeyReachesHostedChatsToo() {
        // Review finding of 2026-10-09: the text said "This chat runs on a local
        // model" for every backend, children and headless runs included. Card
        // 493's switch reaches an Anthropic chat as well, which would then be
        // told something false about itself.
        for (String text : new String[] {CareParagraph.text(2, true), CareParagraph.text(2, false)}) {
            assertFalse(text.toLowerCase(java.util.Locale.ROOT).contains("local"), text);
            assertTrue(text.startsWith("This chat runs with limited capacity"), text);
        }
    }

    @Test
    void withTwoHelpersTheTextIsTheShippedText() {
        assertEquals(CareTexts.TWO_HELPERS, CareParagraph.text(2, true));
    }

    @Test
    void withoutASpawnToolTheSubagentSentenceIsLeftOut() {
        assertEquals(CareTexts.NO_SUBAGENTS, CareParagraph.text(2, false));
        assertEquals(CareTexts.NO_SUBAGENTS, CareParagraph.text(7, false),
                "the count has nowhere to go when the sentence is out");
    }

    @Test
    void theHelperCountIsFilledIn() {
        assertEquals(CareTexts.TWO_HELPERS.replace("at most 2 subagents", "at most 3 subagents"),
                CareParagraph.text(3, true));
    }

    @Test
    void onlyOnTurnsItOn() {
        assertTrue(CareParagraph.enabled("on"));
        assertFalse(CareParagraph.enabled("off"));
        assertFalse(CareParagraph.enabled(null), "unset is the shipped off");
    }

    @Test
    void theSuffixIsTheSeparatorAndTheTextWhenOnAndNothingWhenOff() {
        assertEquals("\n\n" + CareTexts.TWO_HELPERS, CareParagraph.suffix("on", 2, true));
        assertEquals("\n\n" + CareTexts.NO_SUBAGENTS, CareParagraph.suffix("on", 2, false));
        assertEquals("", CareParagraph.suffix("off", 2, true));
        assertEquals("", CareParagraph.suffix(null, 2, true));
    }

    /** A config whose only setting of interest is the chat's session count
     *  (card 490); null leaves it unset. */
    private static SpectroConfig withSessions(Integer sessionsPerChat) {
        SpectroConfig base = new SpectroConfig(
                "ollama", "qwen2.5:7b", "http://localhost:11434", 100_000, "ask",
                List.of(), "gemini", true, List.of(), 2, true,
                List.of(), null, "info", null, null, "auto", "auto", null, null, null, null, null,
                null, false, false);
        return new SpectroConfig(base.provider(), base.model(), base.baseUrl(),
                base.compactionThreshold(), base.permissionMode(), base.autoApprove(),
                base.imageProvider(), base.thinking(), base.mcpServers(), base.maxRetries(),
                base.promptCaching(), base.hooks(), base.workspace(), base.logLevel(),
                base.imageModel(), base.sttModel(), base.sttProvider(), base.sttLanguage(),
                base.chromeBinary(), base.otlpEndpoint(), base.otlpBasicAuth(),
                base.ollamaBaseUrl(), base.lmstudioBaseUrl(), base.searxngUrl(),
                base.allowLocalhost(), base.headlessMcp(), base.progressGuardWrites(),
                base.progressGuardFailures(), base.progressGuardPlanTurns(),
                base.continuationBudget(), base.maxTurns(), base.llamacppBaseUrl(),
                base.questionsPerRun(), base.maxQuestionOptions(), base.maxQuestionChars(),
                base.commandTimeoutSeconds(), base.chatReserveWidth(), base.dockMaxWidth(),
                base.maxTokens(), base.subagentBudgetSeconds(), base.rtkFilter(),
                base.subagentBudgetTokens(), base.desktopNotifications(),
                base.toolResultElision(), base.toolGroupsOff(), sessionsPerChat, "on");
    }

    @Test
    void theHelperCountIsTheChatsSessionCountLessTheMainAgent() {
        // Criterion 2 with card 490 merged: the main agent holds one of the
        // chat's sessions, the helpers share the rest.
        assertEquals(1, CareParagraph.helpersFor(withSessions(2)), "the floor, 2, leaves one helper");
        assertEquals(2, CareParagraph.helpersFor(withSessions(3)));
        assertEquals(4, CareParagraph.helpersFor(withSessions(5)));
    }

    @Test
    void anUnsetCountNamesTheHelpersOfTheProposedSessionCount() {
        assertEquals(SpectroConfig.DEFAULT_SESSIONS_PER_CHAT - 1, CareParagraph.helpersFor(withSessions(null)));
        assertEquals(2, CareParagraph.helpersFor(withSessions(null)), "the concept's two helpers");
    }

    @Test
    void withOneHelperTheSentenceSpeaksOfOneSubagent() {
        // A chat at the floor of two sessions has one helper; "1 subagents"
        // was the text there before this case.
        assertEquals(CareTexts.ONE_HELPER, CareParagraph.text(1, true));
        assertEquals(CareTexts.TWO_HELPERS.replace("at most 2 subagents", "at most 1 subagent"),
                CareTexts.ONE_HELPER, "premise: the typed text differs from two helpers in exactly that word");
    }
}
