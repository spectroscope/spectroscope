#!/usr/bin/env python3
"""Build the spectroscope REST API collections for four clients from one table.

Reads endpoints.json (next to this script) and emits, deterministically:

  spectroscope-api.postman_collection.json   Postman v2.1 — also the import
                                             file for Insomnia and Hoppscotch
  bruno/                                     Bruno native collection folder
                                             (bruno.json + one .bru per request)
  IMPORT-INSOMNIA.md                         import instruction for Insomnia
  IMPORT-HOPPSCOTCH.md                       import instruction for Hoppscotch

This generator is the drift seam, both halves of it: the table is the single
source and the emissions never carry hand edits, AND the table itself is
diffed against the server's controller annotations before anything is
emitted — an endpoint added to the code fails the regeneration until the
table learns it, and a stale table row fails it too. The scan is on by
default (the source tree is auto-detected when this script lives in the
harness repo, or passed via --source-tree); skipping it takes an explicit
--no-source-scan. Re-running twice produces byte-identical output — no
timestamps, no randomness (the Postman collection id is a uuid5 of a fixed
name). Stdlib only.

Usage:  python3 build_api_collections.py [--out DIR] [--source-tree REPO] [--no-source-scan]
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
# Deliberately the classic getpostman.com URL: Bruno's Postman importer
# allowlists exactly this domain (usebruno/bruno#4190) and older clients in
# the field still carry that check.
POSTMAN_FILE = "spectroscope-api.postman_collection.json"
FENCE_CLASSES = {"none", "host", "host+origin", "host+origin+json", "host+json", "host+json+optin"}


# ---------------------------------------------------------------- validation

def validate(table: dict) -> None:
    """The drift guard half that lives in the generator: refuse to emit from a
    table that is internally inconsistent."""
    meta, endpoints = table["meta"], table["endpoints"]
    problems = []
    if len(endpoints) != meta["endpointCount"]:
        problems.append(
            f"meta.endpointCount says {meta['endpointCount']} but the table carries "
            f"{len(endpoints)} endpoints — an endpoint changed without the count learning it"
        )
    ids = [e["id"] for e in endpoints]
    if len(ids) != len(set(ids)):
        dupes = sorted({i for i in ids if ids.count(i) > 1})
        problems.append(f"duplicate endpoint ids: {dupes}")
    area_ids = {a["id"] for a in table["areas"]}
    var_keys = {v["key"] for v in table["variables"]}
    for ep in endpoints:
        where = f"{ep['method']} {ep['path']}"
        if ep["area"] not in area_ids:
            problems.append(f"{where}: unknown area {ep['area']!r}")
        if ep["fence"] not in FENCE_CLASSES:
            problems.append(f"{where}: unknown fence class {ep['fence']!r}")
        if ep["fence"] not in table["meta"]["fenceSemantics"]:
            problems.append(f"{where}: fence class {ep['fence']!r} missing from fenceSemantics")
        for pv in ep["pathVars"]:
            if "{%s}" % pv["name"] not in ep["path"]:
                problems.append(f"{where}: pathVar {pv['name']!r} not present in path")
            if pv["variable"] not in var_keys:
                problems.append(f"{where}: pathVar maps to unknown variable {pv['variable']!r}")
        covered = {pv["name"] for pv in ep["pathVars"]}
        for seg in ep["path"].split("/"):
            if seg.startswith("{") and seg.endswith("}") and seg[1:-1] not in covered:
                problems.append(f"{where}: path segment {seg} has no pathVar mapping")
        blob = json.dumps(ep.get("body")) + json.dumps(ep.get("query", []))
        for token in _var_refs(blob):
            if token not in var_keys:
                problems.append(f"{where}: references unknown variable {{{{{token}}}}}")
    used_areas = {e["area"] for e in endpoints}
    for a in table["areas"]:
        if a["id"] not in used_areas:
            problems.append(f"area {a['id']!r} has no endpoints")
    if problems:
        sys.exit("endpoints.json failed validation:\n  - " + "\n  - ".join(problems))


def _var_refs(text: str):
    out, i = [], 0
    while True:
        i = text.find("{{", i)
        if i < 0:
            return out
        j = text.find("}}", i)
        if j < 0:
            return out
        out.append(text[i + 2 : j])
        i = j + 2


# -------------------------------------------------------------- source scan

SERVER_SRC_SUFFIX = Path("spectro-server/src/main/java")
_MAPPING_ANN = re.compile(r'@(Get|Post|Put|Delete|Patch|Request)Mapping\s*(\(([^)]*)\))?')
_NAMED_PATH = re.compile(r'\b(?:value|path)\s*=\s*"([^"]+)"')
_MEDIA_KW = re.compile(r'\b(?:consumes|produces|headers|params)\s*=\s*"[^"]*"')


def scan_source_tree(src_root: Path) -> tuple[set, list]:
    """Collect (METHOD, path) pairs from Spring mapping annotations under
    src_root. Fails loudly on any annotation shape outside this scanner's
    contract instead of silently missing an endpoint."""
    found, problems = set(), []
    for f in sorted(src_root.rglob("*.java")):
        text = f.read_text(encoding="utf-8")
        for m in _MAPPING_ANN.finditer(text):
            verb, arg = m.group(1), m.group(3)
            where = f"{f.relative_to(src_root)}: {m.group(0)[:70]}"
            if verb == "Request":
                problems.append(f"{where} — @RequestMapping (class-level prefix?) is outside "
                                "this scanner's contract; extend scan_source_tree")
                continue
            if arg is None:
                problems.append(f"{where} — mapping annotation without arguments")
                continue
            named = _NAMED_PATH.search(arg)
            if named:
                path = named.group(1)
            else:
                literals = re.findall(r'"([^"]+)"', _MEDIA_KW.sub("", arg))
                if len(literals) != 1:
                    problems.append(f"{where} — expected exactly one path literal, found {literals}")
                    continue
                path = literals[0]
            found.add((verb.upper(), path))
    return found, problems


def check_against_source(table: dict, src_root: Path) -> None:
    """The other half of the drift guard: the table must match the server's
    controller annotations exactly — an endpoint added to the code fails the
    regeneration until the table learns it, and a stale row fails it too."""
    found, problems = scan_source_tree(src_root)
    in_table = {(e["method"], e["path"]) for e in table["endpoints"]}
    for method, path in sorted(found - in_table):
        problems.append(f"{method} {path} exists in the controllers but not in endpoints.json "
                        "— add the row (with fence class and docs) and re-run")
    for method, path in sorted(in_table - found):
        problems.append(f"{method} {path} is in endpoints.json but no controller maps it "
                        "— stale row?")
    if problems:
        sys.exit(f"source scan against {src_root} failed:\n  - " + "\n  - ".join(problems))
    print(f"source scan: {len(found)} controller mappings == {len(in_table)} table rows ({src_root})")


def resolve_source_tree(arg: Path | None) -> Path | None:
    """--source-tree accepts the harness repo root or the java source root;
    without the flag, walk up from the script looking for the repo layout."""
    if arg is not None:
        for cand in (arg / SERVER_SRC_SUFFIX, arg):
            if cand.is_dir() and any(cand.rglob("*.java")):
                return cand
        sys.exit(f"--source-tree {arg}: no java sources found (looked for {SERVER_SRC_SUFFIX} and *.java)")
    for parent in [HERE, *HERE.parents]:
        cand = parent / SERVER_SRC_SUFFIX
        if cand.is_dir():
            return cand
    return None


# ------------------------------------------------------------------- shared

def request_path(ep: dict) -> str:
    """The endpoint path with {pathVar} placeholders replaced by {{variables}}."""
    p = ep["path"]
    for pv in ep["pathVars"]:
        p = p.replace("{%s}" % pv["name"], "{{%s}}" % pv["variable"])
    return p


def needs_json_header(ep: dict) -> bool:
    return ep.get("body") is not None or "json" in ep["fence"]


def fence_line(ep: dict, semantics: dict) -> str:
    return f"Fence: {ep['fence']} — {semantics[ep['fence']]}"


def request_docs(ep: dict, semantics: dict) -> str:
    """The per-request description carried into every client file."""
    parts = [ep["description"]]
    if ep.get("bodyNote"):
        parts.append("Body: " + ep["bodyNote"])
    if ep.get("caution"):
        parts.append("CAUTION: " + ep["caution"])
    if ep.get("sideEffect"):
        parts.append("Side effect: " + ep["sideEffect"])
    parts.append(fence_line(ep, semantics))
    parts.append("Writes state: " + ("yes" if ep["writes"] else "no"))
    return "\n\n".join(parts)


def collection_overview(table: dict) -> str:
    meta = table["meta"]
    m = meta["fenceMeasurement"]
    lines = [
        f"The whole REST surface of {meta['module']} — "
        f"{meta['endpointCount']} endpoints in {len(table['areas'])} folders, one per area.",
        "",
        "Every request targets {{baseUrl}} = http://{{host}}:{{port}} — change host/port "
        "once in the collection variables to re-target everything.",
        "",
        meta["wsNote"],
        "",
        "## The fences, measured",
        "",
        m["note"],
        "",
        "| endpoint | fence | no Origin | localhost Origin | evil Origin | evil Host |",
        "|---|---|---|---|---|---|",
    ]
    for p in m["probes"]:
        lines.append(
            f"| {p['endpoint']} | {p['fence']} | {p['noOrigin']} | {p['localhostOrigin']} "
            f"| {p['evilOrigin']} | {p['evilHost']} |"
        )
    lines += [
        "",
        meta["refusalShape"],
        "",
        "## Variables",
        "",
    ]
    for v in table["variables"]:
        lines.append(f"- `{{{{{v['key']}}}}}` = `{v['value']}` — {v['note']}")
    lines += [
        "",
        "## Handle with care",
        "",
    ]
    for ep in table["endpoints"]:
        if ep.get("caution"):
            lines.append(f"- **{ep['method']} {ep['path']}** — {ep['caution']}")
    return "\n".join(lines)


# ------------------------------------------------------------------ postman

def build_postman(table: dict) -> dict:
    meta, semantics = table["meta"], table["meta"]["fenceSemantics"]
    by_area: dict[str, list] = {a["id"]: [] for a in table["areas"]}
    for ep in table["endpoints"]:
        by_area[ep["area"]].append(postman_request(ep, semantics))
    folders = []
    for a in table["areas"]:
        folders.append({"name": a["name"], "description": a["description"], "item": by_area[a["id"]]})
    return {
        "info": {
            "_postman_id": str(uuid.uuid5(uuid.NAMESPACE_URL, "https://spectroscope.dev/api-collections/postman/" + meta["collectionName"])),
            "name": meta['collectionName'],
            "description": collection_overview(table),
            "schema": POSTMAN_SCHEMA,
        },
        "item": folders,
        "variable": [
            {"key": v["key"], "value": v["value"], "type": "string", "description": v["note"]}
            for v in table["variables"]
        ],
    }


def postman_request(ep: dict, semantics: dict) -> dict:
    path_t = request_path(ep)
    raw_query, query_items = [], []
    for q in ep.get("query", []):
        item = {"key": q["name"], "value": q.get("example", "")}
        note = q.get("note", "")
        item["description"] = ("required. " if q.get("required") else "optional. ") + note if note else (
            "required" if q.get("required") else "optional"
        )
        if q.get("required"):
            raw_query.append(f"{q['name']}={q.get('example', '')}")
        else:
            item["disabled"] = True
        query_items.append(item)
    url = {
        "raw": "{{baseUrl}}" + path_t + ("?" + "&".join(raw_query) if raw_query else ""),
        "host": ["{{baseUrl}}"],
        "path": [s for s in path_t.split("/") if s],
    }
    if query_items:
        url["query"] = query_items
    request = {
        "method": ep["method"],
        "header": (
            [{"key": "Content-Type", "value": "application/json"}] if needs_json_header(ep) else []
        ),
        "url": url,
        "description": request_docs(ep, semantics),
    }
    if ep.get("body") is not None:
        request["body"] = {
            "mode": "raw",
            "raw": json.dumps(ep["body"], indent=2, ensure_ascii=False),
            "options": {"raw": {"language": "json"}},
        }
    return {"name": ep["name"], "request": request, "response": []}


# -------------------------------------------------------------------- bruno

def bru_block(name: str, lines: list) -> str:
    return name + " {\n" + "".join(f"  {ln}\n" for ln in lines) + "}\n"


def bru_request(ep: dict, seq: int, semantics: dict) -> str:
    chunks = [
        bru_block("meta", [f"name: {ep['name']}", "type: http", f"seq: {seq}"]),
    ]
    body_kind = "json" if ep.get("body") is not None else "none"
    chunks.append(
        bru_block(
            ep["method"].lower(),
            [f"url: {{{{baseUrl}}}}{request_path(ep)}", f"body: {body_kind}", "auth: none"],
        )
    )
    if ep.get("query"):
        q_lines = []
        for q in ep["query"]:
            prefix = "" if q.get("required") else "~"
            q_lines.append(f"{prefix}{q['name']}: {q.get('example', '')}")
        chunks.append(bru_block("params:query", q_lines))
    if needs_json_header(ep):
        chunks.append(bru_block("headers", ["Content-Type: application/json"]))
    if ep.get("body") is not None:
        body_json = json.dumps(ep["body"], indent=2, ensure_ascii=False)
        indented = "".join(f"  {ln}\n" for ln in body_json.splitlines())
        chunks.append("body:json {\n" + indented + "}\n")
    docs = request_docs(ep, semantics)
    chunks.append("docs {\n" + "".join(f"  {ln}\n" for ln in docs.splitlines()) + "}\n")
    return "\n".join(chunks)


def build_bruno(table: dict, root: Path) -> list:
    """Write the Bruno collection folder; returns the list of files written."""
    semantics = table["meta"]["fenceSemantics"]
    if root.exists():
        shutil.rmtree(root)  # removed endpoints must disappear — no stale .bru files
    root.mkdir(parents=True)
    written = []

    def emit(path: Path, content: str):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        written.append(path)

    emit(root / "bruno.json", json.dumps(
        {"version": "1", "name": "spectroscope-api", "type": "collection", "ignore": ["node_modules", ".git"]},
        indent=2) + "\n")
    emit(root / "collection.bru", "docs {\n" + "".join(
        f"  {ln}\n" for ln in collection_overview(table).splitlines()) + "}\n")
    env_lines = [f"{v['key']}: {v['value']}" for v in table["variables"]]
    emit(root / "environments" / "local.bru", bru_block("vars", env_lines))

    by_area: dict[str, list] = {a["id"]: [] for a in table["areas"]}
    for ep in table["endpoints"]:
        by_area[ep["area"]].append(ep)
    for folder_seq, a in enumerate(table["areas"], start=1):
        folder = root / a["id"]
        emit(folder / "folder.bru", bru_block("meta", [f"name: {a['name']}", f"seq: {folder_seq}"])
             + "\n" + "docs {\n" + f"  {a['description']}\n" + "}\n")
        for seq, ep in enumerate(by_area[a["id"]], start=1):
            emit(folder / f"{ep['id']}.bru", bru_request(ep, seq, semantics))
    return written


# ----------------------------------------------------- import instructions

def env_snippet(table: dict) -> str:
    """The variables the requests reference, as a paste-ready environment.

    baseUrl is pre-resolved (host/port substituted) because neither Insomnia
    nor Hoppscotch is guaranteed to carry the nested {{host}}/{{port}}
    composition through a Postman import — one flat URL sidesteps the
    question entirely.
    """
    vals = {v["key"]: v["value"] for v in table["variables"]}
    base = vals["baseUrl"].replace("{{host}}", vals["host"]).replace("{{port}}", vals["port"])
    entries = {"baseUrl": base}
    for v in table["variables"]:
        if v["key"] not in ("host", "port", "baseUrl"):
            entries[v["key"]] = v["value"]
    return json.dumps(entries, indent=2, ensure_ascii=False)


def import_note(client: str, steps: str, why_no_native: str, variables_step: str, table: dict) -> str:
    return f"""# {client}: import the Postman v2.1 file

{client} imports Postman Collection v2.1 directly — use `{POSTMAN_FILE}`
from this folder. {why_no_native}

{steps}

## After the import: create the variables

{variables_step}

```json
{env_snippet(table)}
```

`baseUrl` is deliberately pre-resolved — edit it in place if your server is
not on `localhost:8080`. The other entries are the placeholder ids the
parameterised requests reference (`sessionId`, `skillName`, …); each
request's docs say which list endpoint hands out real values.

One thing to know about the fences: several endpoints are origin-gated. A
desktop REST client sends no browser `Origin` header, which the server treats
as safe — from the same machine, every request in this collection passes.
Details and measured status codes are in the collection description and in
`README.md`.

This file is generated by `build_api_collections.py` — do not edit it by hand.
"""


def build_insomnia_note(table: dict) -> str:
    return import_note(
        "Insomnia",
        "In Insomnia: **Application menu → Import** (or `Import` from the collection\n"
        "list), pick the file, confirm. Postman v2.0/v2.1 is on Insomnia's official\n"
        "importer list (developer.konghq.com/insomnia/import-export/).",
        "We deliberately do not ship a hand-written Insomnia v5 YAML: the format is\n"
        "young, has open importer bugs, and Insomnia's own docs route migrations\n"
        "through the Postman format.",
        "The import carries the folders, requests and docs — but not the collection\n"
        "variables: converting this file with Insomnia's own `insomnia-importers`\n"
        "library yields all folders and requests and zero environment resources\n"
        "(measured 2026-07-30; if your Insomnia build did import them, skip this\n"
        "step). Open the collection's **Base Environment** (Manage Environments)\n"
        "and paste:",
        table,
    )


def build_hoppscotch_note(table: dict) -> str:
    return import_note(
        "Hoppscotch",
        "In Hoppscotch: **Collections → Import → Postman**, pick the file, confirm\n"
        "(docs.hoppscotch.io/documentation/features/importer).",
        "We deliberately do not ship a hand-written Hoppscotch JSON: its native\n"
        "schema is internally versioned (v12 at the time of writing) and migrates\n"
        "often, so the official Postman import path is the stable one.",
        "Hoppscotch's importer brings in collections and requests, but not\n"
        "collection-level variables — its own importer docs note that collection\n"
        "settings are not imported. So the imported requests reference variables\n"
        "that do not exist yet: create an environment (**Environments → New**),\n"
        "add the entries below as its variables, and select it:",
        table,
    )


# --------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=HERE, help="output directory (default: alongside this script)")
    ap.add_argument("--source-tree", type=Path, default=None,
                    help="harness repo root (or java source root) to diff the table against")
    ap.add_argument("--no-source-scan", action="store_true",
                    help="skip the controller scan (the loud opt-out — the emissions then "
                         "carry no proof the table matches the code)")
    args = ap.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    table = json.loads((HERE / "endpoints.json").read_text(encoding="utf-8"))
    validate(table)
    if args.no_source_scan:
        print("source scan: SKIPPED (--no-source-scan) — table not checked against controllers")
    else:
        src_root = resolve_source_tree(args.source_tree)
        if src_root is None:
            sys.exit("source scan: no source tree found. Pass --source-tree <harness repo> "
                     "(the drift guard needs the controllers) or opt out loudly with --no-source-scan.")
        check_against_source(table, src_root)

    postman_path = out / POSTMAN_FILE
    postman_path.write_text(
        json.dumps(build_postman(table), indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    bruno_files = build_bruno(table, out / "bruno")
    (out / "IMPORT-INSOMNIA.md").write_text(build_insomnia_note(table), encoding="utf-8")
    (out / "IMPORT-HOPPSCOTCH.md").write_text(build_hoppscotch_note(table), encoding="utf-8")

    n = table["meta"]["endpointCount"]
    print(f"emitted from {n} endpoints:")
    print(f"  {postman_path.relative_to(out)}  ({postman_path.stat().st_size} bytes)")
    print(f"  bruno/  ({len(bruno_files)} files)")
    print("  IMPORT-INSOMNIA.md")
    print("  IMPORT-HOPPSCOTCH.md")


if __name__ == "__main__":
    main()
