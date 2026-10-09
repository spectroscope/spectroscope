#!/usr/bin/env python3
"""Copy the vendored superpowers skills into the spectro playbook as spectropowers.

Usage, from the repository root:

    python3 scripts/copy_spectropowers.py --date 2026-10-09
    python3 scripts/copy_spectropowers.py --date 2026-10-09 --provenance-only

The full run replaces bundled-playbooks/spectro/skills/spectropowers with a
fresh copy of .spectro/skills-catalogue/superpowers/skills, renames the
folder using-superpowers to using-spectropowers, renames skill references
(superpowers:<name> to spectropowers:<name>, using-superpowers to
using-spectropowers, and the pack word in Markdown headings), copies the
LICENSE byte for byte and writes PROVENANCE.md. A full run discards the
house rule edits made on top of the copy, so it is only for a new source
version.

--provenance-only rewrites PROVENANCE.md alone. It compares every bundled
file with its source and names each one that differs, with the reasons it
can see in the two texts; a difference it cannot explain stops the run, so
the provenance never claims less than the diff holds.

Stdlib only. The same inputs give byte identical output.
"""

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / ".spectro" / "skills-catalogue" / "superpowers"
BUNDLE = ROOT / "spectro-server" / "src" / "main" / "resources" / "bundled-playbooks" / "spectro"
PACK = BUNDLE / "skills" / "spectropowers"

RENAMED_FOLDERS = {"using-superpowers": "using-spectropowers"}

# The nine house rule edits of the spec table: per edited file, the marker
# sentence that shows the edit is in the text, and one line on what changed.
HOUSE_RULES = {
    "brainstorming/SKILL.md": ("chris-criticism", "a ticket is the input of every path; the bounded path writes a short numbered plan into the ticket; chris-criticism runs on the spec before the user review gate"),
    "writing-plans/SKILL.md": ("explicit staging paths", "the plan header names the ticket; commit steps stage explicit paths"),
    "subagent-driven-development/SKILL.md": ("stop and ask the owner", "architecture, language, repository and scope conflicts stop and go to the owner; the ledger is kept and its rulings go into TASKS.md and CLAUDE.md; the failing test comes first in every task; models follow the role rule; reviews may run in the background"),
    "executing-plans/SKILL.md": ("TASKS.md", "the same stop rule for conflicts; progress goes into TASKS.md after every task"),
    "test-driven-development/SKILL.md": ("commit first, break the implementation", "the mutation probe is real: commit first, break the implementation, see red, restore"),
    "test-driven-development/writing-good-tests.md": ("commit first, break the implementation", "the mental mutation is replaced by the real mutation probe"),
    "verification-before-completion/SKILL.md": ("never through a pipe", "gates run with a forced rerun and never through a pipe; UI work is verified in a browser in both themes at two widths"),
    "finishing-a-development-branch/SKILL.md": ("--no-ff", "the merge uses --no-ff; the rulings list goes into TASKS.md before cleanup; chris-criticism runs once on the branch summary"),
    "requesting-code-review/SKILL.md": ("merge base", "the review base is the merge base of the branch, never HEAD~1"),
    "using-spectropowers/SKILL.md": ("take precedence over every skill here", "the rule that user instructions take precedence over every skill is stated first"),
}

DASHES = ("—", "–")
SPACED_HYPHEN = re.compile(r"(?<=\S) - (?=\S)")
INLINE_CODE = re.compile(r"`[^`]*`")
LIST_MARKER = re.compile(r"^\s*([-*]|\d+\.)\s+")


def rename_text(text, markdown):
    text = text.replace("superpowers:", "spectropowers:")
    text = text.replace("using-superpowers", "using-spectropowers")
    if not markdown:
        return text
    out = []
    fence = False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            fence = not fence
        elif not fence and line.startswith("#"):
            line = line.replace("superpowers", "spectropowers").replace("Superpowers", "spectropowers")
        out.append(line)
    return "\n".join(out)


def target_name(rel):
    parts = rel.split("/")
    parts[0] = RENAMED_FOLDERS.get(parts[0], parts[0])
    return "/".join(parts)


def source_name(rel):
    parts = rel.split("/")
    back = {v: k for k, v in RENAMED_FOLDERS.items()}
    parts[0] = back.get(parts[0], parts[0])
    return "/".join(parts)


def files_under(folder):
    return sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*") if p.is_file())


def copy_pack():
    src_skills = SOURCE / "skills"
    if PACK.exists():
        shutil.rmtree(PACK)
    for rel in files_under(src_skills):
        src = src_skills / rel
        dst = PACK / target_name(rel)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        shutil.copymode(src, dst)
        try:
            text = src.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        renamed = rename_text(text, rel.endswith(".md"))
        if renamed != text:
            dst.write_text(renamed, encoding="utf-8")
    shutil.copyfile(SOURCE / "LICENSE", BUNDLE / "LICENSE")


def spaced_hyphens(text):
    count = 0
    fence = False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            fence = not fence
            continue
        if fence:
            continue
        prose = LIST_MARKER.sub("", INLINE_CODE.sub("", line), count=1)
        count += len(SPACED_HYPHEN.findall(prose))
    return count


def reasons(rel, before, after):
    found = []
    if rel in HOUSE_RULES:
        marker, change = HOUSE_RULES[rel]
        if marker in after and marker not in before:
            found.append(change)
    if "superpowers:" in before or "using-superpowers" in before:
        found.append("skill references renamed to spectropowers")
    if sum(before.count(d) for d in DASHES) > sum(after.count(d) for d in DASHES) or (
            rel.endswith(".md") and spaced_hyphens(before) > spaced_hyphens(after)):
        found.append("dashes used as punctuation replaced by commas, colons, parentheses or full stops")
    if before.count("Superpowers") > after.count("Superpowers"):
        found.append("the pack is named spectropowers in prose")
    return found


def provenance(date):
    meta = json.loads((SOURCE / "PROVENANCE.json").read_text(encoding="utf-8"))
    src_skills = SOURCE / "skills"
    changed = []
    same = 0
    unexplained = []
    for rel in files_under(PACK):
        src = src_skills / source_name(rel)
        dst = PACK / rel
        if not src.exists():
            unexplained.append(rel + " has no source file")
            continue
        if src.read_bytes() == dst.read_bytes():
            same += 1
            continue
        why = reasons(rel, src.read_text(encoding="utf-8"), dst.read_text(encoding="utf-8"))
        if not why:
            unexplained.append(rel)
        changed.append((rel, why))
    for rel in files_under(src_skills):
        if not (PACK / target_name(rel)).exists():
            unexplained.append(target_name(rel) + " is missing from the copy")
    if unexplained:
        sys.exit("unexplained differences, add them to HOUSE_RULES: " + ", ".join(unexplained))
    skills = sorted({rel.split("/")[0] for rel in files_under(PACK)})
    lines = [
        "# Provenance",
        "",
        "spectropowers is a copy of the superpowers skills by Jesse Vincent, renamed as a pack and edited to the spectroscope house rules. The MIT licence of the source is in `LICENSE` beside this file and travels with every copy.",
        "",
        "| Field | Value |",
        "|---|---|",
        "| Source | " + meta["repo"] + " |",
        "| Version | " + meta["version"] + " (tag " + meta["tag"] + ") |",
        "| Commit | " + meta["commit"] + " |",
        "| Licence | " + meta["licence"] + ", " + meta["copyright"] + " |",
        "| Vendored into spectroscope | " + meta["vendoredOn"] + ", `.spectro/skills-catalogue/superpowers` |",
        "| Copied into this playbook | " + date + ", by `scripts/copy_spectropowers.py` |",
        "",
        "## Skills",
        "",
        "Every skill keeps its folder name and structure. One line per skill, source first.",
        "",
    ]
    for skill in skills:
        lines.append("- `superpowers:" + source_name(skill) + "` is `spectropowers:" + skill + "`")
    lines += [
        "",
        "## Changed Files",
        "",
        "Each file that differs from its source, with what changed. The list is computed from the two texts by the copy script.",
        "",
        "| File | Change |",
        "|---|---|",
    ]
    for rel, why in changed:
        lines.append("| `" + rel + "` | " + "; ".join(why) + " |")
    lines += [
        "",
        "## Unchanged",
        "",
        str(same) + " files are byte identical to their source.",
        "",
        "Kept as in the source on purpose: the working folders `.superpowers/` and `docs/superpowers/` that the skills and their scripts write to, and the branding of the brainstorming companion page.",
        "",
    ]
    (BUNDLE / "PROVENANCE.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--date", required=True, help="the date of the copy, YYYY-MM-DD")
    parser.add_argument("--provenance-only", action="store_true", help="rewrite PROVENANCE.md only")
    args = parser.parse_args()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
        sys.exit("--date takes YYYY-MM-DD")
    BUNDLE.mkdir(parents=True, exist_ok=True)
    if not args.provenance_only:
        copy_pack()
    provenance(args.date)


if __name__ == "__main__":
    main()
