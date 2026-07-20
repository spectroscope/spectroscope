#!/usr/bin/env python3
"""03 — The provider port: one interface, three backends, three wrappers.

Source-verified against spectro-core/.../core/provider/* and spectro-core/.../core/config/* on 2026-07-16.
"""

import svg_common as C

W = 1680
PAD = 56


def build():
    mk = C.Markers("providers")
    b = []
    head, y0 = C.header(
        W, "spectroscope · architecture dossier · 03",
        "The provider port.",
        "Everything the loop needs from a model sits behind LlmProvider. Wrappers add runtime switching and "
        "retries without the loop noticing; the config layers decide which backend is real.")
    b.append(head)

    col1_x, col1_w = PAD, 430
    col2_x, col2_w = col1_x + col1_w + 70, 560
    col3_x = col2_x + col2_w + 70
    col3_w = W - PAD - col3_x
    top = y0 + 10

    # ---- col 1: the port ------------------------------------------------
    b.append(C.card(col1_x, top, col1_w, 300, "The port", accent=C.ZONE_CORE))
    b.append(C.text(col1_x + 16, top + 52, "interface LlmProvider", 14, C.GREY_LIGHT, mono=True))
    b.append(C.text(col1_x + 16, top + 74, "Iterable<ProviderEvent> stream(ProviderRequest)", 12, C.GREY_MID, mono=True))
    b.append(C.text(col1_x + 16, top + 92, "default String providerName()  // live label", 12, C.GREY_MID, mono=True))
    b.append(C.line(col1_x + 16, top + 106, col1_x + col1_w - 16, top + 106, C.STROKE_SOFT))
    b.append(C.text(col1_x + 16, top + 128, "ProviderRequest", 12.5, C.GREY_LIGHT, mono=True))
    b.append(C.text(col1_x + 16, top + 146, "system · messages · tools · maxTokens · thinking · signal", 11, C.GREY_MID, mono=True))
    b.append(C.text(col1_x + 16, top + 172, "sealed ProviderContent", 12.5, C.GREY_LIGHT, mono=True))
    b.append(C.text(col1_x + 16, top + 190, "Text · ToolCall · ToolResult · Image(base64)", 11, C.GREY_MID, mono=True))
    b.append(C.text(col1_x + 16, top + 216, "sealed ProviderEvent", 12.5, C.GREY_LIGHT, mono=True))
    b.append(C.text(col1_x + 16, top + 234, "PTextDelta · PThinkingDelta · PToolCall", 11, C.GREY_MID, mono=True))
    b.append(C.text(col1_x + 16, top + 250, "PUsage(input, output, cacheRead, cacheCreation)", 11, C.GREY_MID, mono=True))
    b.append(C.text(col1_x + 16, top + 266, "PStop(END_TURN|TOOL_USE|MAX_TOKENS|ABORTED)", 11, C.GREY_MID, mono=True))

    # retry policy card
    rp_y = top + 300 + 24
    b.append(C.card(col1_x, rp_y, col1_w, 168, "RetryPolicy (pure classifier)", accent=C.ZONE_CORE))
    rp = [
        "transient: 408 · 409 · 425 · 429 · status >= 500,",
        "IOException chains, TransientProviderException",
        "terminal 4xx (401, 404 model-not-pulled) never retried",
        "backoff: base 250 ms · cap 8 s · jitter 0.2",
        "SPECTRO_MAX_RETRIES (default 2) · 0 disables wrapping",
    ]
    for i, ln in enumerate(rp):
        b.append(C.text(col1_x + 16, rp_y + 52 + i * 20, ln, 11.5, C.GREY_MID, mono=True))

    # image port card
    im_y = rp_y + 168 + 24
    b.append(C.card(col1_x, im_y, col1_w, 150, "The second port: ImageProvider", accent=C.ZONE_EXT))
    im = [
        "Generated generate(prompt) · providerName() · model()",
        "GeminiImageProvider   x-goog-api-key · flash-image",
        "OpenAiImageProvider   Bearer · gpt-image-1 · 1024px",
        "ImageStore: ~/.spectro/images/<sha256>.<ext> (dedup)",
    ]
    for i, ln in enumerate(im):
        b.append(C.text(col1_x + 16, im_y + 52 + i * 20, ln, 11.5, C.GREY_MID, mono=True))

    # ---- col 2: the wrapper chain + implementations ---------------------
    cy = top
    b.append(C.text(col2_x, cy + 4, "WHAT THE AGENT ACTUALLY HOLDS", 12, C.GREY_MID, ls="0.12em"))
    cy += 18
    chain = [
        ("Agent", "calls provider.stream(request) once per turn", C.ZONE_CORE_DEEP, None),
        ("SwitchableProvider", "AtomicReference delegate · swap() on set_provider · history intact", C.ZONE_FACE_DEEP,
         "server face only"),
        ("RetryingProvider", "retries stream start + first event only · never mid-stream · Sleeper seam", C.ZONE_CORE_DEEP,
         "wrapped in SpectroConfig.providerFromConfig"),
        ("TracingProvider", "prints request + every ProviderEvent to stderr in cyan", C.ZONE_FACE_DEEP,
         "cli face, --verbose only"),
    ]
    for name, sub, accent, note in chain:
        b.append(C.card(col2_x, cy, col2_w, 64, None, accent=accent))
        b.append(C.text(col2_x + 16, cy + 26, name, 14.5, C.WHITE, 700))
        if note:
            b.append(C.text(col2_x + col2_w - 14, cy + 26, note, 10.5, C.GREY_DIM, anchor="end"))
        b.append(C.text(col2_x + 16, cy + 46, sub, 11.5, C.GREY_MID))
        cy += 64
        if name != "TracingProvider":
            b.append(C.arrow(mk, col2_x + col2_w / 2, cy, col2_x + col2_w / 2, cy + 18, C.GREY_MID))
            cy += 22

    cy += 26
    b.append(C.text(col2_x, cy, "THE THREE BACKENDS", 12, C.GREY_MID, ls="0.12em"))
    cy += 14
    impls = [
        ("AnthropicProvider", C.ZONE_EXT_DEEP, [
            "official SDK (only class touching it) · SDK maxRetries(0): spectroscope owns retry",
            "createStreaming + MessageAccumulator · extended thinking, budget 2048",
            "prompt caching: 2 breakpoints (system + tools, last stable message)",
        ]),
        ("OllamaProvider", C.ZONE_EXT_DEEP, [
            "Spring RestClient · POST /api/chat · NDJSON stream · local + key-free",
            "ThinkSplitter folds inline <think> tags into thinking deltas",
            "vision preflight via OllamaApi @PostExchange(/api/show)",
        ]),
        ("OpenAiCompatProvider", C.ZONE_EXT_DEEP, [
            "POST /v1/chat/completions · SSE (data: ... [DONE]) · key optional",
            "assembles tool-call fragments per index · any OpenAI-style server",
            "base URL swap: Ollama :11434 default becomes LM Studio :1234",
        ]),
    ]
    for name, accent, lines in impls:
        h = 34 + len(lines) * 18 + 12
        b.append(C.card(col2_x, cy, col2_w, h, None, accent=accent))
        b.append(C.text(col2_x + 16, cy + 24, name, 14, C.WHITE, 700))
        for i, ln in enumerate(lines):
            b.append(C.text(col2_x + 16, cy + 46 + i * 18, ln, 10.8, C.GREY_MID, mono=True))
        cy += h + 12
    b.append(C.arrow(mk, col2_x + col2_w / 2, top + 4 * 64 + 3 * 22 + 18 + 22,
                     col2_x + col2_w / 2, top + 4 * 64 + 3 * 22 + 58, C.ZONE_EXT))

    # ---- col 3: config precedence ---------------------------------------
    ky = top
    b.append(C.text(col3_x, ky + 4, "WHICH BACKEND IS REAL: THE CONFIG LAYERS", 12, C.GREY_MID, ls="0.12em"))
    ky += 18
    layers = [
        ("built-in defaults", "anthropic · claude-opus-4-8 · ask · retries 2 · caching on"),
        ("environment (.env)", "the BASE · SPECTRO_* deprecated in favor of settings fields · keys stay here"),
        ("~/.spectro/settings.json", "user layer · legacy config.json read beneath it"),
        ("<launch-dir>/.spectro/settings.json", "deprecated compat layer · mcpServers + hooks replace whole blocks"),
        ("<ws>/.spectro/settings.json", "workspace project layer · travels with the workspace repo"),
        ("<ws>/.spectro/settings.local.json", "workspace local layer · machine paths · gitignored"),
        ("CLI flags", "--provider · --model · --base-url · --compaction-threshold"),
    ]
    for i, (name, sub) in enumerate(layers):
        winner = i == len(layers) - 1
        b.append(C.card(col3_x, ky, col3_w, 62, None,
                        accent=C.SAND if winner else None,
                        stroke=C.STROKE if not winner else C.SAND_DEEP))
        b.append(C.text(col3_x + 16, ky + 25, name, 13, C.WHITE, 700, mono=True))
        for j, ln in enumerate(C.wrap(sub, 10.5, col3_w - 30, mono=True)[:2]):
            b.append(C.text(col3_x + 16, ky + 43 + j * 13, ln, 10.5, C.GREY_MID, mono=True))
        ky += 62
        if not winner:
            b.append(C.arrow(mk, col3_x + col3_w / 2, ky, col3_x + col3_w / 2, ky + 14, C.GREY_DIM))
            ky += 18
    b.append(C.text(col3_x, ky + 22, "later layers win field by field · highest wins", 11.5, C.GREY_MID))
    ky += 40

    b.append(C.card(col3_x, ky, col3_w, 190, "ProviderFactory.providerFromConfig", accent=C.ZONE_CORE))
    pf = [
        "builds the selected backend from the",
        "effective SpectroConfig, then wraps it:",
        "RetryingProvider.wrap(real, policy)",
        "",
        "anthropic without ANTHROPIC_API_KEY",
        "throws IllegalStateException; the face",
        "reports it, the core never System.exits",
    ]
    for i, ln in enumerate(pf):
        b.append(C.text(col3_x + 16, ky + 50 + i * 19, ln, 11.5, C.GREY_MID, mono=True))

    bottom = max(cy, ky + 190, im_y + 150) + 40
    b.append(C.legend(PAD, bottom, [
        (C.ZONE_CORE_DEEP, "core", "stroke"),
        (C.ZONE_FACE_DEEP, "face-specific wrapper", "stroke"),
        (C.ZONE_EXT_DEEP, "talks to an external service", "stroke"),
        (C.SAND, "winning config layer", "stroke"),
    ]))
    b.append(C.provenance(W, bottom, "build_03_providers.py"))
    return C.doc(W, bottom + 28, f"<defs>{mk.defs()}</defs>" + "".join(b), "providers")


if __name__ == "__main__":
    C.write("03-provider-port.svg", build())
