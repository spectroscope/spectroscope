package dev.spectroscope.core.provider;

import java.util.List;

/**
 * What one (provider, model) pair honestly supports for reasoning control.
 * Providers consult it before spending a wire field, and the server's
 * capability endpoint serves it verbatim so the picker renders from the same
 * truth the request path acts on. A model that reasons but offers no knob is
 * {@code control="none", defaultOn=true} — the two facts are independent.
 *
 * @param control       "none" (no knob), "toggle" (on/off only) or "effort"
 *                      (a level enum, possibly with an off state)
 * @param defaultOn     whether the model reasons when the request says nothing
 * @param offSwitch     whether an explicit wire-level OFF exists — where false,
 *                      {@code Reasoning.OFF} must not pretend and sends nothing
 * @param efforts       the legal effort values in wire order; empty unless
 *                      {@code control=="effort"}
 * @param defaultEffort the endpoint's documented default effort, or null
 * @param offMaxEffort  OFF is legal only at or below this effort (opus-5's
 *                      disabled×xhigh/max 400), or null when unconstrained
 * @param wire          the wire field the control spends ("think",
 *                      "reasoning_effort", "reasoning", "output_config.effort",
 *                      "thinking.budget_tokens",
 *                      "chat_template_kwargs.enable_thinking"), or null when
 *                      {@code control=="none"}
 * @param source        where this record came from: "static" (the bundled
 *                      table), "api" (live discovery) or "catalog" (the local
 *                      model catalogue plus a measurement against the bundled
 *                      binary)
 */
public record ReasoningCapability(String control, boolean defaultOn, boolean offSwitch,
                                  List<String> efforts, String defaultEffort,
                                  String offMaxEffort, String wire, String source) {

    /** Defensive copies; a null effort list reads as none. */
    public ReasoningCapability {
        efforts = efforts == null ? List.of() : List.copyOf(efforts);
    }

    /** The no-knob record — unknown dialects and non-reasoning models.
     *  @param source where the answer came from
     *  @return a control="none" record with nothing on the wire */
    public static ReasoningCapability none(String source) {
        return new ReasoningCapability("none", false, false, List.of(), null, null, null, source);
    }

    /** @return a copy stamped with a different source (discovery overlays). */
    public ReasoningCapability withSource(String newSource) {
        return new ReasoningCapability(control, defaultOn, offSwitch, efforts,
                defaultEffort, offMaxEffort, wire, newSource);
    }
}
