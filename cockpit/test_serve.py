#!/usr/bin/env python3
"""The cockpit's estate logic, pinned.

Every pure decision serve.py makes is tested here: how the stack registry is
read out of ./spectro-env, how a launch file is found, what "up" means, which
health body identifies a spectro server, when two claims on one port are a
collision, and which cross-origin POST is refused. The gathering itself
(docker, lsof, HTTP) is exercised live, not mocked into meaninglessness.

Run:  python3 cockpit/test_serve.py
"""

import json
import os
import tempfile
import unittest

import serve


STACKS_SNIPPET = """
STACKS=(
  "concourse|concourse|8880|/|the flow-shaped one — pipelines as YAML"
  "jenkins|jenkins|8881|/|a controller AND a separate agent node"
  "renovate|renovate|0|-|dependency updates, run on demand — no server, no port"
)
"""


class ParseStacksTest(unittest.TestCase):
    def test_reads_every_row_of_the_registry(self):
        stacks = serve.parse_stacks(STACKS_SNIPPET)
        self.assertEqual(3, len(stacks))
        self.assertEqual(
            {"name": "concourse", "dir": "concourse", "port": 8880, "path": "/",
             "note": "the flow-shaped one — pipelines as YAML"},
            stacks[0])

    def test_port_zero_means_no_web_face(self):
        stacks = serve.parse_stacks(STACKS_SNIPPET)
        self.assertEqual(0, stacks[2]["port"])

    def test_the_real_registry_parses(self):
        # The whole point: the registry IS ./spectro-env, so drift is impossible.
        with open(os.path.join(serve.REPO_ROOT, "spectro-env"), encoding="utf-8") as f:
            stacks = serve.parse_stacks(f.read())
        names = [s["name"] for s in stacks]
        self.assertIn("jenkins", names)
        self.assertIn("search", names)
        self.assertGreaterEqual(len(stacks), 6)


class FindLaunchFileTest(unittest.TestCase):
    def test_walks_up_to_the_nearest_claude_launch_json(self):
        with tempfile.TemporaryDirectory() as top:
            os.makedirs(os.path.join(top, ".claude"))
            launch = os.path.join(top, ".claude", "launch.json")
            with open(launch, "w", encoding="utf-8") as f:
                f.write("{}")
            deep = os.path.join(top, "a", "b")
            os.makedirs(deep)
            self.assertEqual(launch, serve.find_launch_file(deep))

    def test_none_when_no_ancestor_has_one(self):
        with tempfile.TemporaryDirectory() as top:
            self.assertIsNone(serve.find_launch_file(top, stop=top))

    def test_prefers_our_spectro_launch_json_over_theirs(self):
        # Card 350 split reading from writing: .spectro/launch.json is ours and
        # wins, .claude/launch.json is Claude Code's and is read when we have
        # none. This page reads the same format, so it follows the same order —
        # otherwise a repository configured the new way reads as EMPTY here.
        with tempfile.TemporaryDirectory() as top:
            for folder in (".spectro", ".claude"):
                os.makedirs(os.path.join(top, folder))
                with open(os.path.join(top, folder, "launch.json"), "w",
                          encoding="utf-8") as f:
                    f.write("{}")
            self.assertEqual(os.path.join(top, ".spectro", "launch.json"),
                             serve.find_launch_file(top, stop=top))

    def test_finds_our_launch_json_when_theirs_is_absent(self):
        with tempfile.TemporaryDirectory() as top:
            os.makedirs(os.path.join(top, ".spectro"))
            ours = os.path.join(top, ".spectro", "launch.json")
            with open(ours, "w", encoding="utf-8") as f:
                f.write("{}")
            deep = os.path.join(top, "a", "b")
            os.makedirs(deep)
            self.assertEqual(ours, serve.find_launch_file(deep))

    def test_the_nearer_directory_wins_whichever_file_it_carries(self):
        # The walk is up the tree first, the two folders second: a .claude file
        # in the repository beats a .spectro file three levels above it.
        with tempfile.TemporaryDirectory() as top:
            os.makedirs(os.path.join(top, ".spectro"))
            with open(os.path.join(top, ".spectro", "launch.json"), "w",
                      encoding="utf-8") as f:
                f.write("{}")
            deep = os.path.join(top, "a", "b")
            os.makedirs(os.path.join(deep, ".claude"))
            nearer = os.path.join(deep, ".claude", "launch.json")
            with open(nearer, "w", encoding="utf-8") as f:
                f.write("{}")
            self.assertEqual(nearer, serve.find_launch_file(deep))


class ParseLaunchTest(unittest.TestCase):
    def test_reads_name_port_and_runner(self):
        text = json.dumps({"configurations": [
            {"name": "board", "runtimeExecutable": "python3",
             "runtimeArgs": ["board/server.py"], "port": 8746},
            {"name": "no-port", "runtimeExecutable": "npm"},
        ]})
        configs = serve.parse_launch(text)
        self.assertEqual([{"name": "board", "port": 8746, "runner": "python3"},
                          {"name": "no-port", "port": None, "runner": "npm"}], configs)

    def test_garbage_is_an_empty_list_not_a_crash(self):
        self.assertEqual([], serve.parse_launch("not json"))


class StackStateTest(unittest.TestCase):
    # The same words ./spectro-env status prints, for the same facts.
    def test_no_containers_is_down(self):
        self.assertEqual("down", serve.stack_state(0, 8881, False))

    def test_portless_stack_with_containers_is_ready(self):
        self.assertEqual("ready", serve.stack_state(1, 0, False))

    def test_answering_port_is_up(self):
        self.assertEqual("up", serve.stack_state(2, 8881, True))

    def test_containers_without_an_answer_is_starting(self):
        self.assertEqual("starting", serve.stack_state(2, 8881, False))


class SpectroHealthTest(unittest.TestCase):
    def test_the_health_shape_identifies_a_spectro_server(self):
        self.assertTrue(serve.is_spectro_health('{"status":"ok"}'))

    def test_any_other_answer_does_not(self):
        for body in ("", "ok", '{"status":"green"}', '{"ok":true}', None):
            self.assertFalse(serve.is_spectro_health(body))


class CollisionsTest(unittest.TestCase):
    def test_two_claims_on_one_port_collide(self):
        claims = [(8744, "launch config fleet-tabrow"),
                  (8744, "fleet hub of server :8080"),
                  (8746, "launch config board")]
        self.assertEqual({8744: ["launch config fleet-tabrow", "fleet hub of server :8080"]},
                         serve.collisions(claims))

    def test_the_same_claimant_twice_is_not_a_collision(self):
        self.assertEqual({}, serve.collisions([(8746, "launch config board"),
                                               (8746, "launch config board")]))

    def test_no_ports_no_collisions(self):
        self.assertEqual({}, serve.collisions([]))


class OriginGuardTest(unittest.TestCase):
    # The POST guard: a non-browser caller (no Origin) is the operator; a browser
    # caller must be this page. Any other page on any host is refused.
    def test_absent_origin_is_the_operator(self):
        self.assertTrue(serve.origin_ok(None, "127.0.0.1:8890"))

    def test_the_pages_own_origin_is_allowed(self):
        self.assertTrue(serve.origin_ok("http://127.0.0.1:8890", "127.0.0.1:8890"))
        self.assertTrue(serve.origin_ok("http://localhost:8890", "localhost:8890"))

    def test_a_foreign_page_is_refused(self):
        self.assertFalse(serve.origin_ok("http://localhost:8080", "127.0.0.1:8890"))
        self.assertFalse(serve.origin_ok("https://attacker.example", "127.0.0.1:8890"))

    def test_malformed_origin_is_refused(self):
        self.assertFalse(serve.origin_ok("::::", "127.0.0.1:8890"))


class ActWhitelistTest(unittest.TestCase):
    # Read-only first cut: the only verbs are the ones an existing script has.
    def test_stack_up_and_down_map_to_spectro_env(self):
        self.assertEqual(["./spectro-env", "up", "jenkins"],
                         serve.act_command({"target": "stack", "name": "jenkins", "verb": "up"},
                                           ["jenkins", "search"]))
        self.assertEqual(["./spectro-env", "down", "search"],
                         serve.act_command({"target": "stack", "name": "search", "verb": "down"},
                                           ["jenkins", "search"]))

    def test_server_start_and_stop_map_to_spectro_serve(self):
        self.assertEqual(["./spectro-serve", "start", "--no-open"],
                         serve.act_command({"target": "server", "verb": "start"}, []))
        self.assertEqual(["./spectro-serve", "stop"],
                         serve.act_command({"target": "server", "verb": "stop"}, []))

    def test_everything_else_is_refused(self):
        for req in ({"target": "stack", "name": "jenkins", "verb": "rm"},
                    {"target": "stack", "name": "not-a-stack", "verb": "up"},
                    {"target": "server", "verb": "restart"},
                    {"target": "shell", "verb": "up"},
                    {}):
            self.assertIsNone(serve.act_command(req, ["jenkins"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
