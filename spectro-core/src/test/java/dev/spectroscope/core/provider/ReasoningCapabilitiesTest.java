package dev.spectroscope.core.provider;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The per-model reasoning capability record, resolved from the ONE static
 * resource ({@code reasoning/capabilities.json}). Values follow the card-88
 * research brief (konzept/CARD-88-REASONING-EFFORT-CAPABILITIES.md) except
 * where a live measurement overruled it: the bundled llama-server (build
 * b10107, Qwen3-1.7B) ignores {@code reasoning_effort:"none"} but honors
 * {@code chat_template_kwargs.enable_thinking=false} — measured 2026-07-28,
 * 300 reasoning tokens vs 0.
 */
class ReasoningCapabilitiesTest {

    // ---- anthropic (static fallback rows; the server may overlay /v1/models) ----

    @Test
    void sonnet5CarriesTheFullEffortLadderAndAnOffSwitch() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("anthropic", "claude-sonnet-5");
        assertEquals("effort", cap.control());
        assertTrue(cap.offSwitch(), "sonnet-5 accepts thinking:disabled at any effort");
        assertTrue(cap.defaultOn(), "5-series reasons unless told otherwise");
        assertEquals(List.of("low", "medium", "high", "xhigh", "max"), cap.efforts());
        assertEquals("output_config.effort", cap.wire());
    }

    @Test
    void fableAndMythosHaveNoOffSwitch() {
        // Both "disabled" and "enabled" answer 400 on these models.
        assertFalse(ReasoningCapabilities.resolve("anthropic", "claude-fable-5").offSwitch());
        assertFalse(ReasoningCapabilities.resolve("anthropic", "claude-mythos-5").offSwitch());
        assertTrue(ReasoningCapabilities.resolve("anthropic", "claude-fable-5").defaultOn());
    }

    @Test
    void opus5LimitsTheOffSwitchToHighEffort() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("anthropic", "claude-opus-5");
        assertTrue(cap.offSwitch());
        assertEquals("high", cap.offMaxEffort(), "disabled is a 400 at xhigh/max");
    }

    @Test
    void legacyBudgetFamiliesAreAToggleOnTheBudgetWire() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("anthropic", "claude-sonnet-4-5");
        assertEquals("toggle", cap.control());
        assertEquals("thinking.budget_tokens", cap.wire());
        assertFalse(cap.defaultOn(), "budget thinking is opt-in");
        assertTrue(cap.efforts().isEmpty());
    }

    @Test
    void the46PairHasNoXhigh() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("anthropic", "claude-opus-4-6");
        assertEquals(List.of("low", "medium", "high", "max"), cap.efforts());
    }

    @Test
    void unknownClaudeModelsDefaultToAnAdaptiveToggle() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("anthropic", "claude-nova-9");
        assertEquals("toggle", cap.control());
        assertTrue(cap.defaultOn(), "every generation since 4.6 speaks adaptive, default on");
    }

    // ---- openai (no capability discovery exists; the table IS the truth) ----

    @Test
    void gpt56TakesTheFullEffortEnumIncludingNone() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("openai", "gpt-5.6-turbo");
        assertEquals("effort", cap.control());
        assertEquals(List.of("none", "low", "medium", "high", "xhigh", "max"), cap.efforts());
        assertEquals("medium", cap.defaultEffort());
        assertTrue(cap.offSwitch(), "\"none\" is the off state");
        assertEquals("reasoning_effort", cap.wire());
    }

    @Test
    void plainGpt5RejectsNoneSoThereIsNoOffSwitch() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("openai", "gpt-5-mini");
        assertEquals(List.of("minimal", "low", "medium", "high"), cap.efforts());
        assertFalse(cap.offSwitch());
    }

    @Test
    void oSeriesTakesThreeEffortsAndNoOff() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("openai", "o3-mini");
        assertEquals(List.of("low", "medium", "high"), cap.efforts());
        assertFalse(cap.offSwitch());
    }

    @Test
    void nonReasoningOpenAiFamiliesRenderNothing() {
        assertEquals("none", ReasoningCapabilities.resolve("openai", "gpt-4o").control());
        assertEquals("none", ReasoningCapabilities.resolve("openai", "gpt-4.1-mini").control());
    }

    // ---- gemini (the compat surface spectro speaks) ----

    @Test
    void gemini25FlashIsTheOnlyFamilyWhereNoneWorks() {
        ReasoningCapability flash = ReasoningCapabilities.resolve("gemini", "gemini-2.5-flash");
        assertTrue(flash.offSwitch());
        assertTrue(flash.efforts().contains("none"));
        assertEquals("reasoning_effort", flash.wire());

        ReasoningCapability pro = ReasoningCapabilities.resolve("gemini", "gemini-2.5-pro");
        assertFalse(pro.offSwitch(), "2.5-pro has no zero-thinking state");
        assertFalse(pro.efforts().contains("none"));
    }

    @Test
    void gemini31ProClampsMinimalSoItIsNotOffered() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("gemini", "gemini-3.1-pro");
        assertEquals(List.of("low", "medium", "high"), cap.efforts());
        assertFalse(cap.offSwitch());
    }

    // ---- lmstudio (per-request control does not exist on chat/completions) ----

    @Test
    void lmstudioIsHonestlyUncontrollable() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("lmstudio", "any-model");
        assertEquals("none", cap.control());
        assertNull(cap.wire());
    }

    // ---- ollama (bool-vs-levels is a family table; /api/show only says "thinking") ----

    @Test
    void qwen3FamilyTakesLevelsAndAnOffSwitch() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("ollama", "qwen3:8b");
        assertEquals("effort", cap.control());
        assertTrue(cap.offSwitch());
        assertEquals(List.of("low", "medium", "high", "max"), cap.efforts());
        assertEquals("think", cap.wire());
    }

    @Test
    void gptOssHasLevelsButNoOffState() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("ollama", "gpt-oss:20b");
        assertEquals(List.of("low", "medium", "high"), cap.efforts());
        assertFalse(cap.offSwitch(), "true/false are ignored on gpt-oss");
        assertTrue(cap.defaultOn());
    }

    @Test
    void unknownOllamaModelsKeepTheBooleanToggle() {
        // The translate path already proves think:false works on cloud models
        // the table has never heard of — the catch-all must not regress that.
        ReasoningCapability cap = ReasoningCapabilities.resolve("ollama", "glm-5.2:cloud");
        assertEquals("toggle", cap.control());
        assertTrue(cap.offSwitch());
    }

    // ---- spectro-local (the bundled engine; rows measured, not inferred) ----

    @Test
    void bundledQwen3ModelsSwitchOffViaTheChatTemplate() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("spectro-local", "qwen3-4b");
        assertEquals("toggle", cap.control());
        assertTrue(cap.offSwitch());
        assertEquals("chat_template_kwargs.enable_thinking", cap.wire());
        assertEquals("catalog", cap.source());
    }

    @Test
    void vibeThinkerReasonsUnconditionallyWithNoKnob() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("spectro-local", "vibethinker-3b");
        assertEquals("none", cap.control());
        assertTrue(cap.defaultOn(), "reasoning is trained in, not template-gated");
    }

    @Test
    void theBundledCoderModelDoesNotReason() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("spectro-local", "qwen2-5-coder-7b");
        assertEquals("none", cap.control());
        assertFalse(cap.defaultOn());
    }

    // ---- generic llama.cpp-style custom base + the edges ----

    @Test
    void aCustomCompatBaseGetsABestEffortToggle() {
        ReasoningCapability cap = ReasoningCapabilities.resolve("llamacpp", "whatever-gguf");
        assertEquals("toggle", cap.control());
        assertTrue(cap.offSwitch());
    }

    @Test
    void openrouterFloorIsAToggleUntilDiscoveryRefinesIt() {
        assertEquals("toggle", ReasoningCapabilities.resolve("openrouter", "any/model").control());
    }

    @Test
    void unknownDialectsAndBlankModelsAnswerNoneNotAnException() {
        assertEquals("none", ReasoningCapabilities.resolve("smoke-signal", "m").control());
        // A blank model falls to the dialect's catch-all row, never throws.
        assertEquals("toggle", ReasoningCapabilities.resolve("ollama", "").control());
        assertEquals("none", ReasoningCapabilities.resolve("lmstudio", null).control());
    }
}
