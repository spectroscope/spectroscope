"""Tests for build_local_setup.py and the page it writes (card 529).

Run from the repository root:
    python3 -m unittest discover -s docs/local-setup/tests -v

Standard library only. The builder needs cwebp for the plates, like the guide.
"""

import html
from html.parser import HTMLParser
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCAL_SETUP = HERE.parent
DOCS = LOCAL_SETUP.parent
REPO = DOCS.parent
BUILDER = LOCAL_SETUP / "build_local_setup.py"
STEPS = LOCAL_SETUP / "steps.json"
SCHEMA = LOCAL_SETUP / "steps.schema.json"
PAGE = LOCAL_SETUP / "index.html"
SCRIPTS = LOCAL_SETUP / "scripts"
FIXTURES = HERE / "fixtures"

# The catalogue's step order, research/local-setup-2026-10-11/CATALOGUE.md.
CATALOGUE_STEPS = [
    "1.1", "1.2", "1.3",
    "2.1", "2.2", "2.3", "2.4",
    "3.1", "3.2", "3.3", "3.4", "3.5",
    "4.1", "4.2", "4.3", "4.4",
    "5.1", "5.2", "5.3",
    "6.1", "6.2", "6.3",
    "7.1", "7.2", "7.3", "7.4",
]

# INSTALL-FACTS.md, "What the guide may and may not claim", the "May not
# claim" line, item by item, with the strings that would put each on the page.
MAY_NOT_CLAIM = {
    "check commands marked unverified": [
        "java -version", "brew --version", "git --version", "whisper-cli --help",
        "llama-server --help", "ffmpeg -version", "uv --version", "graphify --help",
        "node --version", "gh --version", "gh auth status", "docker compose version",
        "docker --version",
    ],
    "LM Studio on Linux install method": ["lm-studio.AppImage", "LM-Studio", "lmstudio.ai/download/linux"],
    "Node on Linux": ["apt install nodejs", "apt-get install nodejs", "nodesource"],
    "Docker group step": ["usermod -aG docker", "newgrp docker"],
    "the Debian Docker repository URL": ["download.docker.com/linux/debian"],
    "`npx playwright install chrome`": ["npx playwright install chrome"],
    "`uv tool upgrade graphifyy`": ["uv tool upgrade graphifyy"],
}

PIPE_TO_SHELL = re.compile(r"curl\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash)\b")


# Version-like strings the page may print, by place, with the reason.
# Rule: no version of an external tool. Allowed are the product's own
# requirement (JDK 21, README.md), package names that carry that major,
# the OS releases a line was verified on, OS requirements of a vendor app
# with their S row, model tags, sizes and addresses.
ALLOWED_VERSIONLIKE = {
    # The product's own requirement and the packages that carry it.
    ("1.1", "JDK 21"): "the jar and the CLI zip need JDK 21 (README.md)",
    ("1.2", "Java 21"): "the product's requirement, held by DoctorCommand",
    ("1.2", "openjdk@21"): "package name, S4",
    ("1.2", "openjdk-21.jdk"): "path inside that package, S4",
    ("1.2", "openjdk-21-jdk"): "package name, S53 and S54",
    ("1.2", "temurin-21-jdk"): "package name, S55",
    ("footer", "openjdk@21"): "S4 row",
    ("footer", "openjdk-21-jdk"): "S53 and S54 rows",
    ("footer", "temurin-21-jdk"): "S55 row",
    # OS releases a Linux line was verified on.
    ("header", "Debian 12"): "scope line, S39 and S53",
    ("header", "Ubuntu 22"): "scope line, S37 and S54",
    ("header", "22.04"): "scope line, S37 and S54",
    ("header", "24.04"): "scope line, S37 and S54",
    ("1.1", "Debian 12"): "the apt package's release, README.md",
    ("1.1", "Ubuntu 24"): "the apt package's release, README.md",
    ("1.1", "24.04"): "the apt package's release, README.md",
    ("1.2", "Debian 12"): "S53 and S55",
    ("1.2", "Debian 13"): "S53",
    ("1.2", "Ubuntu 22"): "S54",
    ("1.2", "22.04"): "S54",
    ("1.2", "24.04"): "S54",
    ("footer", "Debian 12"): "S39, S53 and S55 rows",
    ("footer", "Debian 13"): "S39 and S53 rows",
    ("footer", "Ubuntu 22"): "S54 row",
    ("footer", "22.04"): "S54 row",
    ("footer", "24.04"): "S54 row",
    # OS requirements of a vendor app, each with its S row.
    ("2.2", "macOS 14"): "the Ollama app, S11",
    ("2.3", "macOS 14"): "LM Studio, S19",
    ("4.1", "macOS 14"): "Docker Desktop, S35",
    ("footer", "macOS 14"): "S11, S19 and S35 rows",
    # Model names, sizes and addresses, not versions.
    ("2.1", "qwen3-4b"): "model name, models.json",
    ("2.2", "4.7"): "4.7 GB, a size, S14",
    ("footer", "4.7"): "4.7 GB in the S14 row",
    ("footer", "127.0.0.1"): "an address in the S13 row",
}

VERSIONLIKE = [
    re.compile(r"(?<![\w.,])\d+(?:\.\d+)+(?![\w.]*\d)"),
    re.compile(r"\b[A-Za-z][\w.]*[@-]\d+(?:[\w.-]*\w)?"),
    re.compile(r"\b(?:macOS|Python|JDK|Java|Debian|Ubuntu|Node|Docker|Chrome|Homebrew)\s+\d+"),
]
SCRIPT_NAME = re.compile(r"\b(?:mac|linux)-step-\d+-\d+\.sh\b")


def versionlike_by_place(page):
    """(place, string) for every version-like string in the visible text."""
    page = strip_data_uris(page)
    places = []
    head = re.search(r'<header class="top">(.*?)</header>', page, re.S).group(1)
    places.append(("header", head))
    for sid, body in re.findall(r'<article class="card" id="step-([\d.]+)"(.*?)</article>', page, re.S):
        places.append((sid, body))
    places.append(("footer", re.search(r"<footer.*?</footer>", page, re.S).group(0)))
    found = set()
    for place, part in places:
        text = SCRIPT_NAME.sub(" ", visible_text(part))
        for rx in VERSIONLIKE:
            for m in rx.finditer(text):
                if m.group(0) not in CATALOGUE_STEPS:
                    found.add((place, m.group(0)))
    return found


def load_builder():
    spec = importlib.util.spec_from_file_location("build_local_setup", BUILDER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_builder(*args, env=None):
    return subprocess.run(
        [sys.executable, str(BUILDER), *args],
        capture_output=True, text=True, env=env, cwd=str(REPO),
    )


def strip_data_uris(text):
    return re.sub(r"data:[a-z/+]+;base64,[A-Za-z0-9+/=]+", "data:", text)


def visible_text(page):
    """The page without data URIs, scripts and style, tags removed."""
    text = strip_data_uris(page)
    text = re.sub(r"<script\b.*?</script>", " ", text, flags=re.S)
    text = re.sub(r"<style\b.*?</style>", " ", text, flags=re.S)
    text = re.sub(r"<[^>]+>", " ", text)
    return html.unescape(text)


def copy_blocks(page):
    """Every copy block's text, as the copy button hands it to the clipboard."""
    return [html.unescape(m) for m in re.findall(r'<pre class="cmd"[^>]*><code>(.*?)</code></pre>', page, re.S)]


class Refusal(unittest.TestCase):
    """Criterion 1: a command without a source does not build."""

    def test_the_fixture_without_a_source_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "page.html"
            r = run_builder("--steps", str(FIXTURES / "no-source.json"), "--out", str(out),
                            "--scripts", str(Path(tmp) / "scripts"), "--date", "2026-10-11")
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            self.assertNotIn("Traceback", r.stderr, "a crash is not a refusal")
            self.assertRegex(r.stderr, r"commands\.mac\[0\]: missing source|command 1 \('echo fixture'\): no source")
            self.assertFalse(out.exists(), "a refused build must not leave a page behind")

    def test_the_same_fixture_with_its_source_builds(self):
        # The refusal above is about the missing source and nothing else.
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "page.html"
            r = run_builder("--steps", str(FIXTURES / "minimal.json"), "--out", str(out),
                            "--scripts", str(Path(tmp) / "scripts"), "--date", "2026-10-11")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertTrue(out.exists())

    def test_an_unknown_source_is_refused(self):
        doc = json.loads((FIXTURES / "minimal.json").read_text())
        doc["steps"][0]["commands"]["mac"][0]["source"] = "S999"
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text(json.dumps(doc))
            r = run_builder("--steps", str(bad), "--out", str(Path(tmp) / "p.html"),
                            "--scripts", str(Path(tmp) / "s"), "--date", "2026-10-11")
            self.assertEqual(r.returncode, 1)
            self.assertNotIn("Traceback", r.stderr)
            self.assertIn("source S999 is not in the sources table", r.stderr)


class DataFile(unittest.TestCase):
    """Criterion 1: the data file holds the catalogue's steps in its shape."""

    def setUp(self):
        self.builder = load_builder()
        self.doc = json.loads(STEPS.read_text())

    def test_the_steps_are_the_catalogues_step_order(self):
        self.assertEqual([s["id"] for s in self.doc["steps"]], CATALOGUE_STEPS)
        self.assertEqual([lv["id"] for lv in self.doc["levels"]], [1, 2, 3, 4, 5, 6, 7])

    def test_the_data_file_passes_its_schema(self):
        schema = json.loads(SCHEMA.read_text())
        self.assertEqual(self.builder.validate(self.doc, schema), [])

    def test_the_schema_check_bites(self):
        schema = json.loads(SCHEMA.read_text())
        broken = json.loads(json.dumps(self.doc))
        del broken["steps"][0]["enables"]
        self.assertTrue(self.builder.validate(broken, schema), "a step without enables passed the schema")

    def test_the_searxng_step_makes_the_folder_the_app_offer_makes(self):
        # Card 531, fix round 1: the script writes a compose file and
        # searxng/settings.yml (with the instance secret) into the folder it
        # runs in, so both offers make one folder first, the same one.
        source = (REPO / "spectro-web/src/components/webSearchSetup.ts").read_text()
        folder = re.search(r'SEARXNG_FOLDER = "([^"]+)"', source).group(1)
        step = next(s for s in self.doc["steps"] if s["id"] == "4.2")
        for platform in ("mac", "linux"):
            commands = step["commands"][platform]
            self.assertEqual(commands[0]["text"], f"mkdir -p {folder} && cd {folder}", platform)
            self.assertEqual(commands[-1]["text"], "bash install-searxng.sh", platform)
            self.assertIn("that folder", commands[-1]["label"], platform)

    def test_every_step_carries_the_fields_criterion_1_names(self):
        for step in self.doc["steps"]:
            for key in ("id", "level", "title", "enables", "applies", "platforms",
                        "commands", "check", "probe", "script", "shots", "size"):
                self.assertIn(key, step, f"step {step['id']} has no {key}")


class Output(unittest.TestCase):
    """Criteria 2, 3, 5, 6, 9, 11 and the security criteria, read off the page."""

    @classmethod
    def setUpClass(cls):
        cls.page = PAGE.read_text(encoding="utf-8")
        cls.text = visible_text(cls.page)
        cls.doc = json.loads(STEPS.read_text())

    def test_the_tracked_page_is_what_the_builder_writes(self):
        date = re.search(r'data-built="(\d{4}-\d{2}-\d{2})"', self.page).group(1)
        with tempfile.TemporaryDirectory() as tmp:
            out, scripts = Path(tmp) / "page.html", Path(tmp) / "scripts"
            r = run_builder("--out", str(out), "--scripts", str(scripts), "--date", date)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(out.read_bytes(), PAGE.read_bytes(),
                             "docs/local-setup/index.html lags steps.json; run build_local_setup.py")
            built = sorted(p.relative_to(scripts).as_posix() for p in scripts.rglob("*") if p.is_file())
            tracked = sorted(p.relative_to(SCRIPTS).as_posix() for p in SCRIPTS.rglob("*") if p.is_file())
            self.assertEqual(built, tracked)
            for name in built:
                self.assertEqual((scripts / name).read_bytes(), (SCRIPTS / name).read_bytes(), name)

    def test_a_second_run_is_byte_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            outs = []
            for n in (1, 2):
                out, scripts = Path(tmp) / f"p{n}.html", Path(tmp) / f"s{n}"
                r = run_builder("--out", str(out), "--scripts", str(scripts), "--date", "2026-10-11")
                self.assertEqual(r.returncode, 0, r.stderr)
                outs.append((out.read_bytes(), {p.name: p.read_bytes() for p in scripts.rglob("*") if p.is_file()}))
            self.assertEqual(outs[0], outs[1])

    def test_one_file_with_no_external_request(self):
        tags = re.sub(r"(<script\b[^>]*>).*?(</script>)", r"\1\2", self.page, flags=re.S)
        self.assertNotRegex(tags, r'<script[^>]+\bsrc=')
        self.assertNotRegex(self.page, r'<link\b[^>]*rel="?stylesheet')
        self.assertNotIn("@import", self.page)
        self.assertNotRegex(self.page, r"url\(\s*['\"]?https?:")
        for src in re.findall(r'<img[^>]*\bsrc="([^"]*)"', self.page):
            self.assertTrue(src.startswith("data:image/"), src)

    def test_the_website_tokens_and_design_switch_are_inline(self):
        # Inlined without their comments: the comments carry dashes and
        # internal paths, the code is what the page needs.
        builder = load_builder()
        tokens = (LOCAL_SETUP / "site" / "tokens.css").read_text()
        designs = (LOCAL_SETUP / "site" / "designs.js").read_text()
        self.assertIn(builder.strip_css(tokens), self.page)
        self.assertIn(builder.inline_js(builder.strip_js(designs)), self.page)
        self.assertEqual(self.page.count("</script>"), 2, "an inlined script closes its element early")
        self.assertIn(':root[data-design="paper"]', self.page)

    def test_the_vendored_site_files_are_the_website_code_without_comments(self):
        builder = load_builder()
        for name, strip in (("tokens.css", builder.strip_css), ("designs.js", builder.strip_js)):
            site = (LOCAL_SETUP / "site" / name).read_text()
            self.assertEqual(strip(site), site, f"site/{name} still carries comments")
        website = builder.WEBSITE
        if website is None:
            self.skipTest(f"no folder with design/website above {REPO} (CI)")
        for name, strip in (("tokens.css", builder.strip_css), ("designs.js", builder.strip_js)):
            self.assertEqual((LOCAL_SETUP / "site" / name).read_text(), strip((website / name).read_text()),
                             f"site/{name} drifted from design/website/{name}; run the builder with --sync-site")

    def test_under_four_megabytes(self):
        self.assertLess(PAGE.stat().st_size, 4 * 1024 * 1024)

    def test_every_real_plate_is_inline_in_both_designs(self):
        plates = re.findall(r'<img class="shot shot-(dark|light)" data-shot="([^"]+)"', self.page)
        names = {n for _, n in plates}
        self.assertTrue(names, "no plates on the page")
        for name in names:
            self.assertIn(("dark", name), plates)
            self.assertIn(("light", name), plates)

    def test_nothing_animates_on_scroll(self):
        self.assertNotIn(".reveal", self.page)
        self.assertNotIn('class="reveal', self.page)
        self.assertNotIn("IntersectionObserver", self.page)

    def test_the_timeline_has_seven_levels_left_to_right(self):
        self.assertEqual(len(re.findall(r'<button class="tl-level"', self.page)), 7)
        self.assertEqual(len(re.findall(r'class="tl-ring"', self.page)), 7)

    def test_every_card_has_its_parts(self):
        cards = re.findall(r'<article class="card"(.*?)</article>', self.page, re.S)
        shown = [s for s in self.doc["steps"] if s.get("page", True)]
        self.assertEqual(len(cards), len(shown))
        for body in cards:
            self.assertIn('class="mark"', body)
            self.assertIn("I have this", body)
            self.assertIn('class="enables"', body)
            self.assertIn('class="chips"', body)
            self.assertIn('class="check"', body)
            self.assertEqual(body.count('<pre class="cmd"'), body.count('class="copy"'))

    def test_levels_six_and_seven_hold_two_check_only_cards(self):
        for level in (6, 7):
            shown = [s for s in self.doc["steps"] if s["level"] == level and s.get("page", True)]
            self.assertEqual(len(shown), 2, level)
            for s in shown:
                self.assertEqual(s["commands"], {}, s["id"])

    def test_the_platform_switch_detects_like_the_website(self):
        self.assertIn("navigator.userAgentData && navigator.userAgentData.platform", self.page)
        self.assertIn('data-set-platform="mac"', self.page)
        self.assertIn('data-set-platform="linux"', self.page)

    def test_the_mark_key_is_read_and_written_in_try(self):
        self.assertIn("spectroscope:localSetup", self.page)
        script = re.findall(r"<script>(.*?)</script>", self.page, re.S)[-1]
        for m in re.finditer(r"localStorage\.(getItem|setItem)\(", script):
            before = script[max(0, m.start() - 120):m.start()]
            self.assertIn("try", before, "a localStorage call outside a try block")

    def test_every_copy_block_is_a_command_of_the_data_file(self):
        commands = {c["text"] for s in self.doc["steps"] for cs in s["commands"].values() for c in cs}
        blocks = copy_blocks(self.page)
        self.assertTrue(blocks)
        for block in blocks:
            self.assertIn(block, commands)

    def test_the_may_not_claim_list_is_the_one_in_install_facts(self):
        umbrella = load_builder().find_umbrella(REPO)
        if umbrella is None:
            self.skipTest(f"no folder with design/website above {REPO} (CI)")
        facts = umbrella / "research" / "local-setup-2026-10-11" / "INSTALL-FACTS.md"
        line = next(l for l in facts.read_text().splitlines() if l.startswith("- May not claim:"))
        items = [i.strip().rstrip(".") for i in line[len("- May not claim:"):].split(",")]
        self.assertEqual(sorted(items), sorted(MAY_NOT_CLAIM),
                         "INSTALL-FACTS.md changed its list; extend MAY_NOT_CLAIM")

    def test_the_lines_the_research_marks_unverified_are_absent(self):
        for item, needles in MAY_NOT_CLAIM.items():
            for needle in needles:
                self.assertNotIn(needle, self.text, f"{item}: {needle}")
        # LM Studio and Node have no Linux lines at all.
        for step_id in ("2.3",):
            step = next(s for s in self.doc["steps"] if s["id"] == step_id)
            self.assertNotIn("linux", step["commands"])

    def test_no_version_number_of_an_external_tool(self):
        # Every number on the page that looks like a version, per place
        # (a step id, the header, the footer). The allow-list below is the
        # rule; anything new, such as "Python 3.12", fails until someone
        # decides it belongs here and writes the reason.
        version = self.doc["page"]["version"]
        found = versionlike_by_place(self.page)
        allowed = {key for key in ALLOWED_VERSIONLIKE}
        allowed.add(("footer", version))
        self.assertEqual(sorted(set(found) - allowed), [], "a version number not on the allow-list")
        self.assertEqual(sorted(allowed - set(found)), [], "an allow-list entry the page no longer prints; drop it")

    def test_every_size_carries_its_date_and_method(self):
        sizes = re.findall(r'<p class="size">(.*?)</p>', self.page, re.S)
        self.assertTrue(sizes)
        for size in sizes:
            self.assertRegex(size, r"\d{4}-\d{2}-\d{2}")
            self.assertIn("method", size)

    def test_the_jdk_step_is_not_needed_for_the_four_kits(self):
        card = re.search(r'<article class="card" id="step-1\.2"(.*?)</article>', self.page, re.S).group(1)
        self.assertIn("not needed", card)
        for kit in ("DMG", "Homebrew cask", "apt package", "AppImage"):
            self.assertIn(kit, card)

    def test_every_llama_server_command_names_port_8080(self):
        lines = [l for b in copy_blocks(self.page) for l in b.splitlines() if l.startswith("llama-server")]
        self.assertTrue(lines)
        for line in lines:
            self.assertIn("--port 8080", line)

    def test_no_whisper_server(self):
        self.assertNotIn("whisper-server", self.page)

    def test_plain_text_rules(self):
        self.assertNotIn("\u2014", self.text)
        self.assertNotIn("\u2013", self.text)
        source = strip_data_uris(self.page)
        self.assertNotIn("\u2014", source, "an em dash in the page source, comments included")
        self.assertNotIn("\u2013", source, "an en dash in the page source, comments included")
        self.assertNotRegex(self.text, "[\U0001F300-\U0001FAFF☀-➿]")
        self.assertNotIn("Spectroscope", self.text)

    def test_the_footer_carries_version_and_date(self):
        version = self.doc["page"]["version"]
        footer = re.search(r"<footer.*?</footer>", self.page, re.S).group(0)
        self.assertIn(version, footer)
        self.assertRegex(footer, r"\d{4}-\d{2}-\d{2}")
        line = next(l for l in self.page.splitlines() if version in l)
        self.assertNotRegex(line, r"^\s*(//|\*|<!--)", "tag.yml skips comment lines")

    def test_the_tag_straggler_grep_covers_the_page(self):
        tag = (REPO / ".github/workflows/tag.yml").read_text()
        grep = re.search(r'hits="\$\(git grep -n "\$\{old_re\}" -- (.*?)\n', tag).group(1)
        self.assertIn("'*.html'", grep)
        excluded = re.findall(r"':\(exclude\)([^']+)'", tag[tag.index(grep):tag.index(grep) + 600])
        import fnmatch
        for pattern in excluded:
            self.assertFalse(fnmatch.fnmatch("docs/local-setup/index.html", pattern), pattern)

    def test_no_pipe_to_shell_outside_a_vendor_line(self):
        for block in copy_blocks(self.page):
            self.assertNotRegex(block, PIPE_TO_SHELL)
        rest = re.sub(r'<div class="vendor".*?</div>', "", strip_data_uris(self.page), flags=re.S)
        self.assertNotRegex(html.unescape(rest), PIPE_TO_SHELL)
        for vendor in re.findall(r'<div class="vendor".*?</div>', self.page, re.S):
            self.assertRegex(vendor, r'<a [^>]*href="https://')

    def test_no_fetch_eval_or_inline_handlers(self):
        page = strip_data_uris(self.page)
        for needle in ("fetch(", "eval(", "new Function", "XMLHttpRequest", "WebSocket", "sendBeacon"):
            self.assertNotIn(needle, page)
        markup = re.sub(r"<(script|style)\b.*?</\1>", "", page, flags=re.S)
        self.assertNotRegex(markup, r"<[^>]+\son[a-z]+\s*=")

    def test_no_private_names_or_keys(self):
        umbrella = load_builder().find_umbrella(REPO)
        if umbrella is None:
            self.skipTest(f"no folder with design/website above {REPO} (CI)")
        scan = umbrella / "tools" / "prepush-scan.sh"
        pattern = re.search(r"^PATTERN='(.*)'$", scan.read_text(), re.M).group(1)
        regex = re.compile(pattern)
        self.assertIsNone(regex.search(strip_data_uris(self.page)))
        for p in SCRIPTS.rglob("*"):
            if p.is_file():
                self.assertIsNone(regex.search(p.read_text()), p.name)


class ReviewRound1(unittest.TestCase):
    """The findings of the first review of card 529, one test each."""

    @classmethod
    def setUpClass(cls):
        cls.page = PAGE.read_text(encoding="utf-8")
        cls.doc = json.loads(STEPS.read_text())
        cls.builder = load_builder()

    def step(self, sid):
        return next(s for s in self.doc["steps"] if s["id"] == sid)

    def test_no_internal_note_in_the_page_source(self):
        source = strip_data_uris(self.page)
        self.assertNotIn("color-study", source)
        self.assertNotRegex(source, r"owner (?:trial )?\d{4}-\d{2}")

    def test_the_comment_strippers_keep_code_and_drop_comments(self):
        b = self.builder
        js = "const a = 'x // y'; // gone\n/* gone\n too */ const b = \"/* kept */\";\nconst r = /^#a-(\\d)$/.exec(s);\n"
        out = b.strip_js(js)
        self.assertNotIn("gone", out)
        self.assertIn("'x // y'", out)
        self.assertIn('"/* kept */"', out)
        self.assertIn("/^#a-(\\d)$/.exec(s)", out)
        self.assertEqual(b.strip_js(out), out)
        css = ":root {\n  --a: #fff; /* gone \u2014 */\n}\n/* gone */\n.b { content: \"/* kept */\"; }\n"
        out = b.strip_css(css)
        self.assertNotIn("gone", out)
        self.assertIn('content: "/* kept */"', out)
        self.assertEqual(b.strip_css(out), out)

    def test_the_inlined_scripts_still_parse(self):
        import shutil
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not on the PATH")
        for i, script in enumerate(re.findall(r"<script>(.*?)</script>", self.page, re.S)):
            with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as fh:
                fh.write(script)
            try:
                r = subprocess.run([node, "--check", fh.name], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, f"inline script {i}: {r.stderr}")
            finally:
                os.unlink(fh.name)

    def test_linux_docker_steps_say_docker_needs_sudo(self):
        for sid in ("4.1", "4.2"):
            notes = self.step(sid).get("notes", {}).get("linux", [])
            sudo = [n for n in notes if "sudo" in n["text"]]
            self.assertTrue(sudo, f"step {sid} on Linux says nothing about sudo")
            for n in sudo:
                self.assertIn("S37", self.builder.sources_of(n["source"]))
        self.assertNotIn("usermod", self.page)

    def test_the_llama_port_note_names_the_master_branch(self):
        note = self.step("2.4")["notes"]["all"][0]
        self.assertIn("master branch of llama.cpp", note["text"])
        self.assertNotIn("Current llama.cpp builds", note["text"])
        self.assertIn("S22", self.builder.sources_of(note["source"]))

    def test_faint_never_colours_text(self):
        css = (LOCAL_SETUP / "page.css").read_text()
        self.assertNotRegex(css, r"(?<![-\w])color:\s*var\(--faint\)")

    def test_source_links_carry_no_line_number(self):
        self.assertNotRegex(self.page, r'href="https://github\.com/[^"]*#L\d')

    def test_every_product_source_names_a_short_text_its_file_holds(self):
        found = 0
        for src in all_sources(self.doc):
            if not src.startswith("P:"):
                continue
            found += 1
            self.assertRegex(src, r"^P:[^:]+(::.{1,48})?$", src)
            path, _, needle = src[2:].partition("::")
            self.assertTrue((REPO / path).is_file(), src)
            if needle:
                self.assertIn(needle, (REPO / path).read_text(), src)
        self.assertGreater(found, 30)

    def test_a_product_source_whose_text_is_gone_is_refused(self):
        doc = json.loads((FIXTURES / "minimal.json").read_text())
        doc["steps"][0]["commands"]["mac"][0]["source"] = "P:README.md::no such sentence 4711"
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text(json.dumps(doc))
            r = run_builder("--steps", str(bad), "--out", str(Path(tmp) / "p.html"),
                            "--scripts", str(Path(tmp) / "s"), "--date", "2026-10-11")
            self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
            self.assertNotIn("Traceback", r.stderr)
            self.assertIn("README.md does not contain", r.stderr)

    def test_the_download_names_cite_the_playbook_by_name(self):
        step = self.step("1.1")
        links = [l for items in step["links"].values() for l in items]
        self.assertEqual(len(links), 4)
        for link in links:
            name = link["url"].rsplit("/", 1)[-1]
            self.assertEqual(link["source"], f"P:docs/RELEASE-PLAYBOOK.md::{name}", link["label"])

    def test_a_local_run_has_no_link(self):
        self.assertIsNone(self.doc["sources"]["S6"]["url"])
        item = re.search(r'<li id="src-S6">(.*?)</li>', self.page, re.S).group(1)
        self.assertNotIn("<a ", item)
        self.assertIn("local run", item)

    def test_the_scope_line_is_data_with_sources(self):
        scope = self.doc["page"]["scope"]
        self.assertTrue(self.builder.sources_of(scope["source"]))
        self.assertIn(html.escape(scope["text"], quote=True), self.page)
        self.assertNotIn("Debian 12", BUILDER.read_text())

    def test_the_page_stamps_its_inputs_and_itself(self):
        m = re.search(r'^<meta name="spectroscope:build" content="inputs=([0-9a-f]{64}) page=([0-9a-f]{64})">$',
                      self.page, re.M)
        self.assertIsNotNone(m, "the page carries no build stamp")
        self.assertEqual(m.group(1), self.builder.input_digest(self.doc))
        rest = self.page.replace(m.group(0) + "\n", "", 1)
        import hashlib
        self.assertEqual(m.group(2), hashlib.sha256(rest.encode("utf-8")).hexdigest())

    def test_the_input_list_is_derived_from_the_folders(self):
        names = [p.relative_to(REPO).as_posix() for p in self.builder.input_files(self.doc)]
        self.assertEqual(names, sorted(names))
        for folder in ("site", "shots", "shots-light"):
            for f in (LOCAL_SETUP / folder).iterdir():
                if f.is_file():
                    self.assertIn(f.relative_to(REPO).as_posix(), names)
        for fixed in ("build_local_setup.py", "steps.json", "steps.schema.json", "page.css", "page.js"):
            self.assertIn(f"docs/local-setup/{fixed}", names)
        self.assertIn("samples/09-searxng/install.sh", names)
        self.assertNotIn("docs/local-setup/check_page.mjs", names)
        self.assertNotIn("docs/local-setup/index.html", names, "the page may not be an input of itself")


def gradle_version():
    return re.search(r'^version = "([^"]+)"', (REPO / "spectro-server/build.gradle.kts").read_text(), re.M).group(1)


def version_tuple(v):
    return tuple(int(x) for x in v.split("."))


PORT = re.compile(r"(?:localhost|127\.0\.0\.1):(\d+)|--port (\d+)")


def step_texts(step):
    """Every string of a step a reader sees: commands, labels, checks, notes, vendor lines, links."""
    out = []
    for cs in step["commands"].values():
        for c in cs:
            out += [c["text"], c.get("label", "")]
    for check in step["check"].values():
        out += [check.get("text", ""), check.get("expect", "")]
    for group in ("notes", "vendor", "links"):
        for items in step.get(group, {}).values():
            for item in items:
                out += [item.get("text", ""), item.get("says", ""), item.get("label", ""), item.get("url", "")]
    return [t for t in out if t]


class ReviewRound2(unittest.TestCase):
    """The findings of the second review of card 529, one test each."""

    @classmethod
    def setUpClass(cls):
        cls.page = PAGE.read_text(encoding="utf-8")
        cls.doc = json.loads(STEPS.read_text())
        cls.builder = load_builder()

    def step(self, sid):
        return next(s for s in self.doc["steps"] if s["id"] == sid)

    # Finding 1: the footer version is a literal the release preparation sets.
    def test_the_footer_prints_the_version_of_the_data_file(self):
        version = self.doc["page"].get("version")
        self.assertRegex(version or "", r"^\d+\.\d+\.\d+$", "steps.json page.version is missing")
        footer = re.search(r"<footer.*?</footer>", self.page, re.S).group(0)
        self.assertIn(f"spectroscope {version}.", footer)
        self.assertNotIn("build.gradle.kts", BUILDER.read_text(),
                         "the builder reads the build file; tag.yml bumps it after the page is built")

    def test_the_page_version_is_the_release_or_the_one_being_prepared(self):
        self.assertGreaterEqual(version_tuple(self.doc["page"]["version"]), version_tuple(gradle_version()))

    def test_the_playbook_puts_the_page_version_into_the_preparation(self):
        playbook = (REPO / "docs/RELEASE-PLAYBOOK.md").read_text()
        bullet = " ".join(re.search(r"- \*\*The Local Setup page:\*\*(.*?)\n- ", playbook, re.S).group(1).split())
        self.assertIn("page.version", bullet)
        self.assertIn("release preparation", bullet)
        self.assertNotIn("after the bump", bullet)

    # Finding 2: every port a provider step prints is the preset's port.
    def test_every_port_in_a_provider_step_is_its_address_port(self):
        checked = {}
        for step in self.doc["steps"]:
            if "address" not in step:
                continue
            want = step["address"]["url"].rsplit(":", 1)[1]
            hits = [a or b for text in step_texts(step) for a, b in PORT.findall(text)]
            for port in hits:
                self.assertEqual(port, want, f"step {step['id']} prints port {port}, the preset is {want}")
            checked[step["address"]["provider"]] = len(hits)
        self.assertGreater(checked.get("lmstudio", 0), 0, "the LM Studio step names no port")
        self.assertGreater(checked.get("llamacpp", 0), 0, "the llama.cpp step names no port")

    # Finding 3: Homebrew and git are named where a line needs them.
    def test_every_brew_line_needs_homebrew_and_linux_has_none(self):
        needs = self.doc["page"].get("needs", {})
        self.assertIn("homebrew", needs)
        self.assertIn("git", needs)
        for step in self.doc["steps"]:
            for platform, cs in step["commands"].items():
                for c in cs:
                    lines = c["text"].splitlines()
                    if any(l.startswith("brew ") for l in lines):
                        self.assertNotEqual(platform, "linux", f"step {step['id']}: a Homebrew line on Linux")
                        self.assertIn("homebrew", c.get("needs", []), f"step {step['id']} {c['text']!r}")
                    if any(l.startswith("git clone") for l in lines):
                        self.assertIn("git", c.get("needs", []), f"step {step['id']} {c['text']!r}")
        # The copied product scripts that call brew on macOS.
        for step in self.doc["steps"]:
            if isinstance(step["script"], dict):
                calls_brew = any("command -v brew" in (REPO / c["from"]).read_text() for c in step["script"]["copy"])
                if calls_brew:
                    for c in step["commands"].get("mac", []):
                        self.assertIn("homebrew", c.get("needs", []), f"step {step['id']} {c['text']!r}")

    def test_the_page_names_homebrew_with_its_link_and_no_pipe_line(self):
        head = re.search(r'<header class="top">(.*?)</header>', self.page, re.S).group(1)
        need = re.search(r'<div class="need" id="needs-homebrew"><p data-platform="mac">(.*?)</p></div>', head, re.S)
        self.assertIsNotNone(need, "the header does not name Homebrew")
        self.assertIn('href="https://brew.sh"', need.group(1))
        self.assertNotRegex(html.unescape(need.group(1)), PIPE_TO_SHELL)
        self.assertIn('id="needs-git"', head)
        brew_boxes = 0
        for box in re.findall(r'<div class="cmdbox">.*?<p class="cmd-src">', self.page, re.S):
            code = html.unescape(re.search(r"<code>(.*?)</code>", box, re.S).group(1))
            if any(l.startswith("brew ") for l in code.splitlines()):
                brew_boxes += 1
                self.assertIn('href="#needs-homebrew"', box, code)
        self.assertGreater(brew_boxes, 5)

    # Finding 4: the script header says what the file holds.
    def test_the_script_header_does_not_claim_every_copy_block(self):
        pre = self.builder.SCRIPT_PREAMBLE
        self.assertNotIn("copy blocks, unchanged", pre)
        self.assertIn("separately", pre)
        for path in SCRIPTS.glob("*-step-*.sh"):
            preamble, _ = self.builder.split_script(path.read_text())
            self.assertNotIn("copy blocks, unchanged", preamble, path.name)

    # Card 530 fix round 2: a script run alone names what has to come first.
    def test_the_docker_engine_line_needs_docker_s_apt_repository(self):
        need = self.doc["page"]["needs"].get("docker-repo")
        self.assertIsNotNone(need, "page.needs does not explain Docker's apt repository")
        self.assertEqual(set(need["platforms"]), {"linux"})
        self.assertIn("S38", self.builder.sources_of(need["platforms"]["linux"]["source"]))
        lines = 0
        for step in self.doc["steps"]:
            for platform, cs in step["commands"].items():
                for c in cs:
                    if any(l.startswith("sudo apt install docker-ce") for l in c["text"].splitlines()):
                        lines += 1
                        self.assertIn("docker-repo", c.get("needs", []), f"step {step['id']} {c['text']!r}")
        self.assertGreater(lines, 0)

    def test_the_shape_check_refuses_a_docker_engine_line_without_its_need(self):
        doc = json.loads(STEPS.read_text())
        for step in doc["steps"]:
            for c in step["commands"].get("linux", []):
                if c["text"].startswith("sudo apt install docker-ce"):
                    c["needs"] = []
        problems = self.builder.check_shape(doc)
        self.assertTrue(any("needs docker-repo and does not say so" in p for p in problems), problems)

    def test_a_script_header_names_what_its_lines_need_first(self):
        needs = self.doc["page"]["needs"]
        checked = 0
        for step in self.doc["steps"]:
            if step["script"] != "generate":
                continue
            for platform, commands in step["commands"].items():
                lines = [c for c in commands if c.get("script", True)]
                if not lines:
                    continue
                name = self.builder.script_name(step["id"], platform)
                preamble, _ = self.builder.split_script((SCRIPTS / name).read_text())
                wanted = [needs[n]["name"] for c in lines for n in c.get("needs", [])]
                for want in wanted:
                    self.assertIn(want, preamble, name)
                    checked += 1
                if not wanted:
                    self.assertNotIn("Needs first", preamble, name)
        self.assertGreater(checked, 0)
        preamble, _ = self.builder.split_script((SCRIPTS / "linux-step-4-1.sh").read_text())
        self.assertIn("# Needs first: Docker's apt repository.", preamble)

    def test_the_playbook_names_the_sync_s_real_refusals(self):
        # the sync checks the build stamp, not mtimes (card 530 fix round 1)
        playbook = (REPO / "docs/RELEASE-PLAYBOOK.md").read_text()
        bullet = " ".join(re.search(r"- \*\*Local Setup page\*\*(.*?)\n- ", playbook, re.S).group(1).split())
        self.assertNotIn("older than", bullet)
        for words in ("missing", "hand-edited", "steps.json", "page.css", "page.js", "en or em dash",
                      "build_local_setup.py", "on `main`"):
            self.assertIn(words, bullet)

    # Finding 5: the umbrella folder is found from both checkout layouts.
    def test_the_umbrella_is_found_from_the_main_checkout_and_from_a_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp).resolve() / "Spectroscope"
            (home / "design" / "website").mkdir(parents=True)
            (home / "design" / "website" / "tokens.css").write_text(":root{}")
            main = home / "spectroscope-harness" / "spectro"
            tree = home / "spectroscope-harness" / "worktrees" / "wt-x"
            for repo in (main, tree):
                (repo / "docs").mkdir(parents=True)
                self.assertEqual(self.builder.find_umbrella(repo), home, repo)
            self.assertIsNone(self.builder.find_umbrella(Path(tmp).resolve() / "elsewhere" / "a" / "b"))

    def test_the_umbrella_of_this_checkout_is_found_when_it_exists(self):
        found = self.builder.find_umbrella(REPO)
        if found is None:
            self.skipTest(f"no folder with design/website above {REPO} (CI); the umbrella checks below skip too")
        self.assertTrue((found / "design" / "website" / "tokens.css").is_file())
        self.assertTrue((found / "tools" / "prepush-scan.sh").is_file())
        self.assertTrue((found / "research" / "local-setup-2026-10-11" / "INSTALL-FACTS.md").is_file())
        self.assertEqual(self.builder.WEBSITE, found / "design" / "website")
        fixed_depth = "REPO.parent" + ".parent.parent"
        self.assertNotIn(fixed_depth, (HERE / "test_build_local_setup.py").read_text())
        self.assertNotIn(fixed_depth, BUILDER.read_text())


VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


class PlatformView(HTMLParser):
    """What a card shows with one platform switched on: the page's CSS hides
    every element whose data-platform names the other platform."""

    def __init__(self, platform):
        super().__init__(convert_charrefs=True)
        self.platform = platform
        self.stack = []
        self.text = []
        self.tags = []

    def hidden(self):
        return any(self.stack)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        hide = a.get("data-platform") not in (None, self.platform)
        if tag in VOID_TAGS:
            if not self.hidden() and not hide:
                self.tags.append((tag, a, len(self.text)))
            return
        self.stack.append(hide)
        if not self.hidden():
            self.tags.append((tag, a, len(self.text)))

    def handle_endtag(self, tag):
        if tag not in VOID_TAGS and self.stack:
            self.stack.pop()

    def handle_data(self, data):
        if not self.hidden():
            self.text.append(data)


def card_view(page, sid, platform):
    """(visible text, visible tags) of one card with `platform` switched on."""
    body = re.search(rf'<article class="card" id="step-{re.escape(sid)}".*?</article>',
                     strip_data_uris(page), re.S).group(0)
    view = PlatformView(platform)
    view.feed(body)
    return " ".join(" ".join(view.text).split()), view.tags


def size_lines(page, sid, platform):
    body = re.search(rf'<article class="card" id="step-{re.escape(sid)}".*?</article>', page, re.S).group(0)
    out = []
    for m in re.finditer(r'<p class="size"( data-platform="(\w+)")?>(.*?)</p>', body, re.S):
        if m.group(2) in (None, platform):
            out.append(html.unescape(re.sub(r"<[^>]+>", "", m.group(3))))
    return out


class ReviewRound3(unittest.TestCase):
    """The final check of card 529 and the orchestrator's decisions of round 3."""

    @classmethod
    def setUpClass(cls):
        cls.page = PAGE.read_text(encoding="utf-8")
        cls.doc = json.loads(STEPS.read_text())
        cls.builder = load_builder()

    def step(self, sid):
        return next(s for s in self.doc["steps"] if s["id"] == sid)

    def shown(self):
        return [s for s in self.doc["steps"] if s.get("page", True)]

    # Decision 1: the tracked layout is the served layout.
    def test_the_tracked_page_sits_beside_its_scripts(self):
        self.assertEqual(Path(self.builder.OUT), LOCAL_SETUP / "index.html")
        self.assertTrue(PAGE.is_file(), "docs/local-setup/index.html is missing")
        self.assertFalse((DOCS / "LOCAL-SETUP.html").exists(), "docs/LOCAL-SETUP.html is the old place")
        links = re.findall(r'<a class="dl" href="([^"]+)"', self.page)
        self.assertGreater(len(links), 10)
        for href in links:
            self.assertTrue(href.startswith("scripts/"), href)
            self.assertTrue((PAGE.parent / href).is_file(), f"{href} does not resolve beside the tracked page")

    # Decision 2: one name for the SearXNG script on the website and in the app.
    def test_the_searxng_script_has_the_name_the_app_serves(self):
        java = (REPO / "spectro-server/src/main/java/dev/spectroscope/server/web/LocalSetupScriptController.java").read_text()
        served = re.search(r'String FILE_NAME = "([^"]+)"', java).group(1)
        web = re.search(r'SEARXNG_SCRIPT_NAME = "([^"]+)"',
                        (REPO / "spectro-web/src/components/webSearchSetup.ts").read_text()).group(1)
        self.assertEqual(served, "install-searxng.sh")
        self.assertEqual(web, served)
        step = self.step("4.2")
        targets = {c["from"]: c["to"] for c in step["script"]["copy"]}
        self.assertEqual(targets["samples/09-searxng/install.sh"], served)
        self.assertEqual(targets["samples/09-searxng/docker-compose.yml"], "docker-compose.yml",
                         "the compose file sits beside the script")
        self.assertTrue((SCRIPTS / served).is_file())
        self.assertFalse((SCRIPTS / "searxng").exists(), "the old scripts/searxng folder")
        for platform in ("mac", "linux"):
            self.assertEqual(step["commands"][platform][-1]["text"], f"bash {served}")
            self.assertIn(f'href="scripts/{served}"', card_view_html(self.page, "4.2"))

    def test_no_step_text_names_the_searxng_script_by_its_sample_name(self):
        old = re.compile(r"(?<![-\w])install\.sh")
        for text in step_texts(self.step("4.2")):
            self.assertNotRegex(text, old)

    # Finding 2: a size line shows on the platforms its file is for.
    def test_every_size_names_platforms_the_step_covers(self):
        for step in self.doc["steps"]:
            for size in step["size"]:
                self.assertTrue(size.get("platforms"), f"step {step['id']}: {size['text']!r} names no platforms")
                self.assertLessEqual(set(size["platforms"]), set(step["platforms"]), step["id"])
                if ".dmg" in size["text"]:
                    self.assertEqual(size["platforms"], ["mac"], size["text"])

    def test_no_dmg_size_shows_under_linux(self):
        dmg_mac = 0
        for step in self.shown():
            for line in size_lines(self.page, step["id"], "linux"):
                self.assertNotIn(".dmg", line, f"step {step['id']} under Linux")
            dmg_mac += sum(".dmg" in line for line in size_lines(self.page, step["id"], "mac"))
            text, _ = card_view(self.page, step["id"], "linux")
            self.assertNotIn(".dmg:", text, step["id"])
        self.assertEqual(dmg_mac, 2, "Ollama.dmg and Docker.dmg show under macOS")
        self.assertTrue(any("qwen2.5:7b" in l for l in size_lines(self.page, "2.2", "linux")),
                        "the model size still shows under Linux")

    def test_the_shape_check_refuses_a_size_for_an_uncovered_platform(self):
        doc = json.loads(STEPS.read_text())
        for step in doc["steps"]:
            if step["id"] == "2.3":
                step["size"] = [{"text": "x", "date": "2026-10-11", "method": "m", "source": "S17",
                                 "platforms": ["mac", "linux"]}]
        problems = self.builder.check_shape(doc)
        self.assertTrue(any("step 2.3: size 1 is for linux" in p for p in problems), problems)

    # Finding 3: a platform a step does not cover shows no check.
    def test_an_uncovered_platform_shows_no_check(self):
        uncovered = 0
        for step in self.shown():
            for platform in ("mac", "linux"):
                text, tags = card_view(self.page, step["id"], platform)
                classes = [a.get("class", "") for _, a, _ in tags]
                if platform in step["platforms"]:
                    self.assertTrue(any(c in ("cmd-check", "check-text") for c in classes),
                                    f"step {step['id']} shows no check on {platform}")
                else:
                    uncovered += 1
                    self.assertIn("not covered on", text, step["id"])
                    self.assertNotIn("copy-check", classes, f"step {step['id']} {platform}")
                    self.assertNotIn("cmd-check", classes, f"step {step['id']} {platform}")
                    self.assertNotIn("check-text", classes, f"step {step['id']} {platform}")
        self.assertGreater(uncovered, 0)

    def test_the_shape_check_refuses_shared_parts_on_a_partly_covered_step(self):
        doc = json.loads(STEPS.read_text())
        step = next(s for s in doc["steps"] if s["id"] == "2.3")
        step["check"] = {"all": step["check"].get("mac") or step["check"].get("all")}
        step.setdefault("notes", {})["all"] = [{"text": "x", "source": "S17"}]
        problems = self.builder.check_shape(doc)
        self.assertTrue(any("step 2.3: check all on a step that does not cover linux" in p for p in problems), problems)
        self.assertTrue(any("step 2.3: notes all on a step that does not cover linux" in p for p in problems), problems)

    # Finding 4: cmake and ollama lines name what they need.
    def test_cmake_and_ollama_lines_name_their_needs(self):
        needs = self.doc["page"]["needs"]
        self.assertIn("linux", needs["build-tools"]["platforms"])
        self.assertIn("S24", self.builder.sources_of(needs["build-tools"]["platforms"]["linux"]["source"]))
        self.assertIn("linux", needs["ollama"]["platforms"])
        self.assertIn("S12", self.builder.sources_of(needs["ollama"]["platforms"]["linux"]["source"]))
        for entry in (needs["build-tools"]["platforms"]["linux"], needs["ollama"]["platforms"]["linux"]):
            self.assertNotRegex(entry["text"], r"apt(-get)? install", "no invented install line")
        cmake = ollama = 0
        for step in self.doc["steps"]:
            for platform, cs in step["commands"].items():
                installed = False
                for c in cs:
                    lines = c["text"].splitlines()
                    if any(l.startswith("cmake ") for l in lines):
                        cmake += 1
                        self.assertIn("build-tools", c.get("needs", []), f"{step['id']} {c['text']!r}")
                    if any(l.startswith("ollama ") for l in lines) and not installed:
                        ollama += 1
                        self.assertIn("ollama", c.get("needs", []), f"{step['id']} {platform} {c['text']!r}")
                    installed = installed or any(l.startswith("brew install ollama") for l in lines)
        self.assertEqual(cmake, 2)
        self.assertGreater(ollama, 0)

    def test_the_shape_check_refuses_cmake_and_ollama_lines_without_their_needs(self):
        doc = json.loads(STEPS.read_text())
        for step in doc["steps"]:
            for c in step["commands"].get("linux", []):
                c["needs"] = [n for n in c.get("needs", []) if n not in ("build-tools", "ollama")]
        problems = self.builder.check_shape(doc)
        self.assertTrue(any("step 3.2 linux 'cmake -B build': needs build-tools" in p for p in problems), problems)
        self.assertTrue(any("step 2.2 linux 'ollama pull qwen2.5:7b': needs ollama" in p for p in problems), problems)
        mac_ok = [p for p in problems if p.startswith("step 2.2 mac")]
        self.assertEqual(mac_ok, [], "brew install ollama comes first on macOS")

    def test_the_linux_script_headers_name_cmake_and_ollama(self):
        needs = self.doc["page"]["needs"]
        pre, _ = self.builder.split_script((SCRIPTS / "linux-step-3-2.sh").read_text())
        self.assertIn(needs["build-tools"]["name"], pre)
        self.assertIn("git", pre)
        pre, _ = self.builder.split_script((SCRIPTS / "linux-step-2-2.sh").read_text())
        self.assertIn("# Needs first: Ollama.", pre)
        pre, _ = self.builder.split_script((SCRIPTS / "mac-step-2-2.sh").read_text())
        self.assertNotIn("Ollama.", pre.split("Needs first:", 1)[-1] if "Needs first:" in pre else "")

    # Finding 5: the Docker repository need names the Debian page too.
    def test_the_docker_repo_need_links_ubuntu_and_debian(self):
        entry = self.doc["page"]["needs"]["docker-repo"]["platforms"]["linux"]
        self.assertIn("S39", self.builder.sources_of(entry["source"]))
        head = re.search(r'<div class="need" id="needs-docker-repo">(.*?)</div>', self.page, re.S).group(1)
        for sid in ("S38", "S39"):
            self.assertIn(f'href="{html.escape(self.doc["sources"][sid]["url"])}"', head, sid)
        self.assertIn("Debian", html.unescape(re.sub(r"<[^>]+>", " ", head)))
        self.assertNotIn("download.docker.com/linux/debian", self.page)

    # Finding 6: no literal dash in the sources of the page, tests included.
    def test_no_literal_dash_in_the_local_setup_files(self):
        skip = {".webp-cache", "shots", "shots-light", "__pycache__"}
        checked = 0
        for f in sorted(LOCAL_SETUP.rglob("*")):
            if not f.is_file() or skip & set(f.relative_to(LOCAL_SETUP).parts):
                continue
            if f.suffix not in {".py", ".json", ".css", ".js", ".mjs", ".sh", ".yml", ".html", ".md"}:
                continue
            text = f.read_text(encoding="utf-8")
            checked += 1
            self.assertNotIn("\u2013", text, f.relative_to(REPO).as_posix())
            self.assertNotIn("\u2014", text, f.relative_to(REPO).as_posix())
        self.assertGreater(checked, 20)

    # Finding 1: every S id the page cites has a verified row in the register.
    def test_every_cited_source_has_a_verified_row_in_the_register(self):
        umbrella = self.builder.find_umbrella(REPO)
        if umbrella is None:
            self.skipTest(f"no umbrella folder above {REPO} (CI); the register lives there")
        register = umbrella / "research" / "local-setup-2026-10-11" / "sources.md"
        rows = {}
        for line in register.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\|\s*(S\d+)\s*\|(.*)\|\s*(\S+)\s*\|\s*$", line)
            if m:
                rows[m.group(1)] = (m.group(2), m.group(3).lower())
        cited = sorted(set(re.findall(r'id="src-(S\d+)"', self.page)), key=lambda s: int(s[1:]))
        self.assertGreater(len(cited), 30)
        for sid in cited:
            self.assertIn(sid, rows, f"{sid} has no row in {register.name}")
            self.assertEqual(rows[sid][1], "yes", f"{sid} is not verified")
        for sid in ("S62", "S64", "S65", "S66", "S67"):
            self.assertIn("2026-10-11", rows[sid][0], f"{sid} names no read date")
        s24 = rows["S24"][0]
        self.assertIn("git clone https://github.com/ggml-org/whisper.cpp", s24)
        self.assertIn("cd whisper.cpp", s24)

    # Finding 8: the text pass (humanizer and chris-criticism, round 3).
    def test_a_note_that_quotes_a_mark_quotes_the_mark_as_it_reads(self):
        quoted = 0
        for key, item in self.doc["page"]["needs"].items():
            for platform, entry in item["platforms"].items():
                for label in re.findall(r'marked "needs ([^"]+)"', entry["text"]):
                    quoted += 1
                    self.assertEqual(label, item["name"], f"{key} {platform} quotes a mark the page does not show")
        self.assertGreater(quoted, 2)

    def test_the_level_two_goal_names_the_paths_that_need_no_extra_install(self):
        goal = next(lv for lv in self.doc["levels"] if lv["id"] == 2)["goal"]
        if "no extra install" in goal:
            for path in ("DMG", "cask", "apt", "AppImage"):
                self.assertIn(path, goal, "the jar and the CLI zip need llama-server (step 2.1)")

    def test_the_text_pass_words(self):
        texts = " ".join(step_texts(self.step("4.4")) + step_texts(self.step("3.3")))
        self.assertNotIn(" wins", texts, "an order of precedence, said plainly")
        self.assertNotIn("can download the same file from Settings and checks", texts)


def card_view_html(page, sid):
    return re.search(rf'<article class="card" id="step-{re.escape(sid)}".*?</article>', page, re.S).group(0)


class BrowserCheck(unittest.TestCase):
    """Criteria 4 and 5 in a real browser: check_page.mjs on the tracked page.

    Runs where node, Playwright and the installed Chrome channel are present
    (this Mac); skips with the reason elsewhere, so CI stays green without a
    browser. LOCAL_SETUP_BROWSER_OUT keeps the screenshots and result.json.
    """

    CHECK = LOCAL_SETUP / "check_page.mjs"
    WANT = (
        "copy yields exactly the line",
        "the apt copy equals linux-step-1-1.sh byte for byte",
        "the mark is still set after a reload and the ring shows one of four",
        "with storage blocked the page renders and the mark counts",
        "on Linux no .dmg size shows",
        "on Linux LM Studio shows no check",
    )

    def setUp(self):
        import shutil
        if not shutil.which("node"):
            self.skipTest("node is not installed")
        probe = subprocess.run(
            ["node", "--input-type=module", "-e",
             "import {chromium} from 'playwright'; const b = await chromium.launch({channel: 'chrome'}); await b.close();"],
            capture_output=True, text=True, cwd=str(LOCAL_SETUP), timeout=120)
        if probe.returncode != 0:
            self.skipTest("Playwright with the Chrome channel is not available: " + probe.stderr.strip()[-200:])

    def test_the_browser_check_passes_on_the_tracked_page(self):
        keep = os.environ.get("LOCAL_SETUP_BROWSER_OUT")
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(keep) if keep else Path(tmp)
            env = dict(os.environ, PAGE_URL=PAGE.resolve().as_uri(), SCRIPTS_DIR=str(SCRIPTS),
                       OUT_DIR=str(out), LABEL="unittest")
            r = subprocess.run(["node", str(self.CHECK)], capture_output=True, text=True,
                               cwd=str(LOCAL_SETUP), env=env, timeout=900)
            self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-2000:])
            result = json.loads((out / "unittest-result.json").read_text())
        names = {c["name"]: c["ok"] for c in result["checks"]}
        for want in self.WANT:
            self.assertTrue(names.get(want), f"{want}: {names.get(want)}")
        self.assertTrue(all(names.values()))


def all_sources(doc):
    out = []

    def walk(value, key=None):
        if isinstance(value, dict):
            for k, v in value.items():
                walk(v, k)
        elif isinstance(value, list):
            for v in value:
                walk(v, key)
        elif key == "source" and isinstance(value, str):
            out.append(value)
    walk(doc["steps"])
    walk(doc["page"])
    return out


class Scripts(unittest.TestCase):
    """Criterion 7 and the security criteria on the scripts."""

    SOURCES = {
        "setup-stt.sh": "scripts/setup-stt.sh",
        "setup-tts.sh": "scripts/setup-tts.sh",
        "install-searxng.sh": "samples/09-searxng/install.sh",
        "docker-compose.yml": "samples/09-searxng/docker-compose.yml",
    }

    def setUp(self):
        self.builder = load_builder()
        self.doc = json.loads(STEPS.read_text())

    def test_the_product_scripts_are_copied_byte_for_byte(self):
        for name, source in self.SOURCES.items():
            self.assertEqual((SCRIPTS / name).read_bytes(), (REPO / source).read_bytes(), name)

    def test_every_generated_script_carries_its_steps_commands(self):
        generated = [s for s in self.doc["steps"] if s["script"] == "generate"]
        self.assertTrue(generated)
        for step in generated:
            for platform, commands in step["commands"].items():
                name = self.builder.script_name(step["id"], platform)
                if not any(c.get("script", True) for c in commands):
                    self.assertFalse((SCRIPTS / name).exists(), f"{name}: no line of the step belongs in a script")
                    continue
                text = (SCRIPTS / name).read_text()
                preamble, body = self.builder.split_script(text)
                self.assertIn("set -euo pipefail", preamble)
                self.assertIn("docs/local-setup/index.html", preamble)
                self.assertRegex(preamble, r"\d{4}-\d{2}-\d{2}")
                expected = "\n".join(c["text"] for c in commands if c.get("script", True)) + "\n"
                self.assertEqual(body, expected, name)

    def test_every_copy_block_equals_its_script(self):
        page = PAGE.read_text(encoding="utf-8")
        for step in self.doc["steps"]:
            if step["script"] != "generate":
                continue
            for platform, commands in step["commands"].items():
                name = self.builder.script_name(step["id"], platform)
                if not any(c.get("script", True) for c in commands):
                    continue
                _, body = self.builder.split_script((SCRIPTS / name).read_text())
                section = re.search(
                    rf'<article class="card" id="step-{re.escape(step["id"])}"(.*?)</article>', page, re.S).group(1)
                plat = re.search(rf'<div class="plat" data-platform="{platform}">(.*?)<!--/plat-->', section, re.S).group(1)
                blocks = [b for b, c in zip(copy_blocks(plat), commands) if c.get("script", True)]
                self.assertEqual("\n".join(blocks) + "\n", body, name)

    def test_generated_scripts_use_sudo_only_where_the_line_does(self):
        for step in self.doc["steps"]:
            if step["script"] != "generate":
                continue
            for platform, commands in step["commands"].items():
                if not any(c.get("script", True) for c in commands):
                    continue
                text = (SCRIPTS / self.builder.script_name(step["id"], platform)).read_text()
                self.assertNotRegex(text, PIPE_TO_SHELL)
                if not any("sudo" in c["text"] for c in commands):
                    self.assertNotIn("sudo", text)


if __name__ == "__main__":
    unittest.main()
