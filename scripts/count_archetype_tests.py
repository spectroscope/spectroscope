#!/usr/bin/env python3
"""Count the tests every rendered Spectrolyzr project ran and fail on zero.

Usage:
  count_archetype_tests.py <language> <root>
  count_archetype_tests.py <language> <folder> <output-file>

The two argument form walks <root>/*/project and reads each project's check.log
(written by build_archetypes.py). The three argument form counts one project
folder from the named output file. Java reads the JUnit XML under
build/test-results/test, Python the "Ran N tests" line, TypeScript the TAP
"# tests N" line. A missing log or summary counts as zero. One line
"<folder>: N tests" per project goes to stdout and, when GITHUB_STEP_SUMMARY
names a file, to that file as well. Exit 0 when every project ran a test, 1
when one ran none or none was found, 2 on bad arguments.
"""

import glob
import os
import re
import sys
import xml.etree.ElementTree as ET

LANGUAGES = ("typescript", "python", "java")
PYTHON_SUMMARY = re.compile(r"^Ran (\d+) tests?\b", re.MULTILINE)
TAP_SUMMARY = re.compile(r"^# tests (\d+)$", re.MULTILINE)


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return ""


def last_number(pattern, text):
    matches = pattern.findall(text)
    return int(matches[-1]) if matches else 0


def count(language, folder, output_file):
    if language == "java":
        total = 0
        for path in sorted(glob.glob(os.path.join(folder, "build", "test-results", "test", "*.xml"))):
            try:
                total += int(ET.parse(path).getroot().attrib.get("tests", 0))
            except (ET.ParseError, ValueError, OSError):
                continue
        return total
    text = read(output_file or os.path.join(folder, "check.log"))
    if language == "python":
        return last_number(PYTHON_SUMMARY, text)
    return last_number(TAP_SUMMARY, text)


def main(argv):
    if len(argv) not in (3, 4) or argv[1] not in LANGUAGES:
        print(__doc__, file=sys.stderr)
        return 2
    language = argv[1]
    if len(argv) == 4:
        targets = [(argv[2], argv[3])]
    else:
        targets = [(path, None) for path in sorted(glob.glob(os.path.join(argv[2], "*", "project")))]
        if not targets:
            print("no project folders found under " + argv[2], file=sys.stderr)
            return 1

    lines = []
    failed = False
    for folder, output_file in targets:
        number = count(language, folder, output_file)
        lines.append(f"{folder}: {number} tests")
        if number == 0:
            failed = True
            print(f"::error::{folder} ran zero tests. A green build without a test count "
                  "means the suite was skipped, not that it passed.", file=sys.stderr)
    for line in lines:
        print(line)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(f"### spectrolyzr gate: {language}\n\n")
            for line in lines:
                handle.write(f"- {line}\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
