#!/usr/bin/env python3
"""18 — The built-in model: from a file on disk to an answer in the chat.

The keyless path, drawn as the four things it actually is: where the GGUF is
found, how it gets there when it is not, the llama-server the JVM supervises,
and the one capability fact that keeps the loop honest about tools.

Everything here is read off the source it documents:
  spectro-core/.../local/LocalModel.java        the id, the file name, the roots
  spectro-core/.../local/LocalRuntime.java      port, health probe, budget
  spectro-core/.../local/ModelProfile.java      reasoning yes, native tools no
  spectro-server/.../ServerLocalRuntime.java    the exec line
  spectro-server/.../LocalModelController.java  the pinned url, sha256, size

Theme: SPECTRO_DIAGRAM_THEME=dark|light, like every other build_*.py here.
"""

import svg_common as C

W = 1680
PAD = 56


def step(x, y, w, n, title, lines, accent, chips=None):
    """One stage of the path, numbered so the eye keeps its place."""
    h = 40 + 22 * len(lines) + (34 if chips else 0)
    out = [C.card(x, y, w, h, accent=accent)]
    out.append(C.text(x + 22, y + 31, f"{n}", 13, C.GREY_DIM, mono=True))
    out.append(C.text(x + 48, y + 32, title, 18, C.WHITE, weight=600))
    ty = y + 58
    for line in lines:
        out.append(C.text(x + 48, ty, line, 13, C.GREY_LIGHT))
        ty += 22
    if chips:
        row, _ = C.chip_row(x + 48, ty - 8, chips, w - 80, color=accent, size=12)
        out.append(row)
    return "".join(out), h


def build():
    head, y = C.header(
        W, "the built-in models", "spectro-local",
        "a catalogue of GGUFs, a supervised llama-server, and no key anywhere")
    body = [head]
    y += 22

    col_w = (W - 2 * PAD - 24) / 2
    left_x, right_x = PAD, PAD + col_w + 24

    # ---- column 1: getting a file there ----
    chunk, h1 = step(
        left_x, y, col_w, "1", "choosing, and where a model is looked for",
        ["local/models.json names five models; the chooser shows",
         "what each is good for, whether it can drive tools, and",
         "whether THIS machine holds it (memory + disk measured).",
         "Each file: the app bundle first, the user home second."],
        C.ZONE_DISK,
        ["local/models.json", "spectro.bundle.models", "~/.spectro/models"])
    body.append(chunk)

    chunk, h2 = step(
        left_x, y + h1 + 16, col_w, "2", "when one is absent",
        ["Per model one pinned URL straight to its publisher, one",
         "pinned sha256, one pinned size. The bytes are verified",
         "BEFORE the file is moved into place, so a truncated or",
         "swapped download never becomes the model the next boot",
         "loads. Two different models may download concurrently."],
        C.ZONE_EXT,
        ["1.8 – 5.0 GB", "sha256-pinned", "atomic move"])

    body.append(chunk)

    # ---- column 2: making it answer ----
    chunk, h3 = step(
        right_x, y, col_w, "3", "the runtime the JVM supervises",
        ["llama-server, spawned lazily on first use and shared by",
         "every session in the process. A free loopback port, the",
         "chosen model's own context budget, /v1/models polled for",
         "up to 60 s. Switching models restarts it — a llama-server",
         "keeps serving the weights it was started with."],
        C.ZONE_CORE,
        ["127.0.0.1:<free>", "-c <per model>", "--jinja", "reaped on JVM exit"])
    body.append(chunk)

    chunk, h4 = step(
        right_x, y + h3 + 16, col_w, "4", "what the loop is told about it",
        ["The provider is the ordinary OpenAI-compatible one, aimed",
         "at localhost with no key. The capability is a per-model",
         "fact: the Qwen entries speak tool_calls and get the full",
         "registry; VibeThinker does not, and is offered none."],
        C.LILAC,
        ["Qwen: tools ✓", "VibeThinker: tools ✗"])
    body.append(chunk)

    y += max(h1 + h2, h3 + h4) + 16 + 34

    # Hand-set line breaks, like the card bodies above: est_w under-measures this
    # face badly enough at 13px that wrap() leaves a 250-character paragraph on
    # one line and it runs off the canvas.
    for para in (
        ["The honest limit: a local model in these sizes stays below the cloud "
         "models — simpler answers, smaller context. But the",
         "default Coder 7B genuinely drives the file tools, and the catalogue "
         "exists so a fresh install can produce a real run —",
         "its own events, its own trace, its own session file — before anyone "
         "has decided whether to pay for a key."],
        ["Nothing about the rest of the product knows it is local. The events, the "
         "gate, the trace and the JSONL are the same",
         "ones a cloud provider produces, which is the whole reason the keyless "
         "walkthrough of the ladder reaches deep field."],
    ):
        for row in para:
            body.append(C.text(PAD, y, row, 13, C.GREY_MID))
            y += 21
        y += 12
    y -= 12

    height = y + 56
    body.append(C.provenance(W, height - 22, "build_18_local_model.py"))
    C.write("18-local-model.svg", C.doc(W, height, "".join(body), "18-local-model"))


if __name__ == "__main__":
    build()
