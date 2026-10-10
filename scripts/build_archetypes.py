#!/usr/bin/env python3
"""Build and test every project that RenderAll rendered.

Usage: build_archetypes.py <language> <root>

Walks <root>/*/project in name order. In each project it runs the install step
of the language (npm install for TypeScript, none for Python and Java) and then
the check command that RenderAll wrote to <root>/<folder>/check-command.txt.
All output of a project goes to <project>/check.log, written straight to the
file and never through a pipe. Every project is tried even after a failure.
Exit 0 when every project passed, 1 when one failed or none was found, 2 on bad
arguments.
"""

import glob
import os
import shlex
import subprocess
import sys

INSTALL = {
    "typescript": ["npm", "install"],
    "python": None,
    "java": None,
}
TIMEOUT_SECONDS = 20 * 60


def run(command, folder, log):
    log.write(f"$ {' '.join(command)}\n")
    log.flush()
    try:
        result = subprocess.run(command, cwd=folder, stdout=log, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, timeout=TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        log.write(f"\nTimed out after {TIMEOUT_SECONDS} seconds\n")
        return 124
    except OSError as failure:
        log.write(f"\nCould not start the command: {failure}\n")
        return 127
    log.write(f"\n[exit {result.returncode}]\n")
    log.flush()
    return result.returncode


def build(language, project):
    check_file = os.path.join(os.path.dirname(project), "check-command.txt")
    try:
        with open(check_file, encoding="utf-8") as handle:
            check = shlex.split(handle.read().strip())
    except OSError:
        check = []
    with open(os.path.join(project, "check.log"), "w", encoding="utf-8") as log:
        if not check:
            log.write("No check command found beside the project.\n")
            return False
        install = INSTALL[language]
        if install is not None and run(install, project, log) != 0:
            return False
        return run(check, project, log) == 0


def main(argv):
    if len(argv) != 3 or argv[1] not in INSTALL:
        print(__doc__, file=sys.stderr)
        return 2
    language, root = argv[1], argv[2]
    projects = sorted(glob.glob(os.path.join(root, "*", "project")))
    if not projects:
        print("no project folders found under " + root, file=sys.stderr)
        return 1
    failed = []
    for project in projects:
        passed = build(language, project)
        print(f"{'PASS' if passed else 'FAIL'} {project}", flush=True)
        if not passed:
            failed.append(project)
    if failed:
        print(f"{len(failed)} of {len(projects)} projects failed; see check.log in each.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
