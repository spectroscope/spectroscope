#!/usr/bin/env python3
"""The cockpit's estate server — card 238.

One page that answers "what is running on this machine, and how is it doing".
The first cockpit was a static page whose only sense was a no-cors fetch: it
could tell a door from a wall and nothing more. This server gives the page real
facts, gathered server-side where no CORS fence stands in the way:

  GET  /api/estate   stacks (from ./spectro-env's own registry, parsed at
                     runtime so it cannot drift), launch configs (the nearest
                     .claude/launch.json up the tree), spectro servers
                     (discovered by probing java-held listening ports for
                     /api/health), their fleet hubs and nodes (/api/fleet),
                     and every port claimed twice.
  POST /api/act      start/stop ONLY through the scripts that already exist
                     (./spectro-env up|down <stack>, ./spectro-serve start|stop).
                     Whitelisted verbs, origin-guarded, loopback-bound.

Zero dependencies: python3 stdlib only, same as serve.sh always was. A thing
that does not answer is reported as not answering, never omitted — that is the
card's third criterion and the whole reason to trust the page.
"""

import json
import os
import re
import subprocess
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

COCKPIT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(COCKPIT_DIR)

PROBE_TIMEOUT = 0.8          # per HTTP probe, seconds — a door answers fast
ESTATE_CACHE_SECONDS = 2.0   # the page polls; the machine is asked at most this often


# ---- the pure decisions (pinned in test_serve.py) ---------------------------

def parse_stacks(text):
    """The stack registry, read out of ./spectro-env itself.

    The rows live in the STACKS=( ... ) block as "name|dir|port|path|note".
    Parsing the script at runtime is the no-drift move: there is exactly one
    registry, and it is the one the operator's own command reads.
    """
    stacks = []
    in_block = False
    for line in text.splitlines():
        if re.match(r"^\s*STACKS=\(", line):
            in_block = True
            continue
        if in_block and re.match(r"^\s*\)", line):
            break
        if not in_block:
            continue
        m = re.match(r'^\s*"([^|"]+)\|([^|"]*)\|(\d+)\|([^|"]*)\|([^"]*)"\s*$', line)
        if m:
            stacks.append({"name": m.group(1), "dir": m.group(2),
                           "port": int(m.group(3)), "path": m.group(4),
                           "note": m.group(5)})
    return stacks


def find_launch_file(start, stop=None):
    """The nearest .claude/launch.json at or above start; None when no ancestor
    has one. `stop` bounds the walk (tests); the filesystem root bounds it anyway."""
    d = os.path.abspath(start)
    while True:
        candidate = os.path.join(d, ".claude", "launch.json")
        if os.path.isfile(candidate):
            return candidate
        if d == stop or os.path.dirname(d) == d:
            return None
        d = os.path.dirname(d)


def parse_launch(text):
    """Launch configs as {name, port, runner}. Garbage is an empty list — a
    missing or broken file is reported by the caller, not crashed over."""
    try:
        doc = json.loads(text)
    except (ValueError, TypeError):
        return []
    configs = []
    for c in doc.get("configurations", []) if isinstance(doc, dict) else []:
        if not isinstance(c, dict) or "name" not in c:
            continue
        port = c.get("port")
        configs.append({"name": str(c["name"]),
                        "port": port if isinstance(port, int) else None,
                        "runner": str(c.get("runtimeExecutable", ""))})
    return configs


def stack_state(containers, port, answers):
    """The same words ./spectro-env status prints, for the same facts."""
    if containers == 0:
        return "down"
    if port == 0:
        return "ready"
    return "up" if answers else "starting"


def is_spectro_health(body):
    """Whether a body is the spectro server's health answer: {"status":"ok"}."""
    try:
        return json.loads(body).get("status") == "ok"
    except (ValueError, TypeError, AttributeError):
        return False


def collisions(claims):
    """Ports claimed by two or more DIFFERENT claimants. claims: [(port, label)]."""
    by_port = {}
    for port, label in claims:
        if port is None:
            continue
        by_port.setdefault(port, [])
        if label not in by_port[port]:
            by_port[port].append(label)
    return {p: labels for p, labels in by_port.items() if len(labels) > 1}


def origin_ok(origin, host):
    """The POST guard. No Origin header is a non-browser caller — the operator's
    own curl. A browser caller must be this very page (Origin == our own host).
    Everything else — another local port, another site — is refused."""
    if not origin:
        return True
    try:
        parts = urlsplit(origin)
        if parts.scheme not in ("http", "https") or not parts.netloc:
            return False
        return parts.netloc == host
    except ValueError:
        return False


def act_command(req, stack_names):
    """The full whitelist of what /api/act may run: exactly the verbs an
    existing script already has, nothing composed. None means refused."""
    if not isinstance(req, dict):
        return None
    target, verb = req.get("target"), req.get("verb")
    if target == "stack" and verb in ("up", "down") and req.get("name") in stack_names:
        return ["./spectro-env", verb, req["name"]]
    if target == "server" and verb == "start":
        return ["./spectro-serve", "start", "--no-open"]
    if target == "server" and verb == "stop":
        return ["./spectro-serve", "stop"]
    return None


# ---- the gathering (exercised live, not mocked) -----------------------------

def run(cmd, timeout=6):
    """A command's stdout, or None when it fails or times out."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.stdout if p.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def docker_containers():
    """{compose-project: [container-state, ...]} from ONE docker ps, or None when
    the docker daemon is not answering — which the estate reports as exactly that."""
    out = run(["docker", "ps", "--format",
               '{{.Names}}\t{{.State}}\t{{.Label "com.docker.compose.project"}}'],
              timeout=4)
    if out is None:
        return None
    projects = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 3 and parts[2]:
            projects.setdefault(parts[2], []).append(parts[1])
    return projects


def listening_ports():
    """[{port, pid, cmd}] for every listening TCP socket, via lsof. Ports are
    deduplicated (IPv4+IPv6 double-listen counts once)."""
    out = run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-FpcnT"], timeout=5)
    if out is None:
        return []
    rows, pid, cmd = [], None, None
    seen = set()
    for line in out.splitlines():
        tag, value = line[:1], line[1:]
        if tag == "p":
            pid = int(value)
        elif tag == "c":
            cmd = value
        elif tag == "n":
            m = re.search(r":(\d+)$", value)
            if m:
                port = int(m.group(1))
                if (pid, port) not in seen:
                    seen.add((pid, port))
                    rows.append({"port": port, "pid": pid, "cmd": cmd})
    return rows


def http_get(port, path):
    """A localhost GET's body, or None when nothing answers in time."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                     headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=PROBE_TIMEOUT) as resp:
            return resp.read().decode("utf-8", "replace")
    except OSError:
        return None


def answers(port, path="/"):
    """Whether ANY http answer comes back — spectro-env's own liveness rule:
    a 403 from a Jenkins still booting is listening, and that is the fact."""
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=PROBE_TIMEOUT)
        return True
    except urllib.error.HTTPError:
        return True          # it answered; the status is its business
    except OSError:
        return False


def json_or_none(text):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def read_stacks():
    with open(os.path.join(REPO_ROOT, "spectro-env"), encoding="utf-8") as f:
        return parse_stacks(f.read())


def gather_stacks(docker):
    """Every registry stack with its honest state. docker=None means the daemon
    is not answering, and every stack says so rather than guessing "down"."""
    stacks = []
    for s in read_stacks():
        row = dict(s)
        if docker is None:
            row.update(containers=None, state="docker not answering", answers=False)
        else:
            n = len(docker.get(s["dir"], []))
            up = answers(s["port"], s["path"]) if (n and s["port"]) else False
            row.update(containers=n, state=stack_state(n, s["port"], up), answers=up)
        stacks.append(row)
    return stacks


def gather_servers(ports):
    """Spectro servers, discovered rather than declared: every java-held
    listening port that answers /api/health with the health shape. For each,
    /api/config (provider+model) and /api/fleet (hub port + nodes) — and when
    one of those does not answer, the row says so."""
    servers = []
    for row in ports:
        if row["cmd"] != "java" or row["port"] > 65535:
            continue
        if not is_spectro_health(http_get(row["port"], "/api/health")):
            continue
        server = {"port": row["port"], "pid": row["pid"]}
        config = json_or_none(http_get(row["port"], "/api/config"))
        server["provider"] = (config or {}).get("provider") or None
        server["model"] = (config or {}).get("model") or None
        if config is None:
            server["config"] = "not answering"
        fleet = json_or_none(http_get(row["port"], "/api/fleet"))
        if fleet is None:
            server["fleet"] = "not answering"
        else:
            server["fleet"] = {"enabled": bool(fleet.get("enabled")),
                               "hubPort": fleet.get("hubPort"),
                               "nodes": [{"id": n.get("id"), "role": n.get("role"),
                                          "connected": n.get("connected"),
                                          "lastSeen": n.get("lastSeen")}
                                         for n in fleet.get("nodes", [])]}
        servers.append(server)
    # One port can carry only one server; keep the list ordered.
    return sorted(servers, key=lambda s: s["port"])


def gather_launch(ports_by_number):
    """The nearest launch file's configs, each with whether its port is held
    right now and by which command. Held is a fact about the PORT — the holder
    may or may not be that config, and the page says only what is measurable."""
    path = find_launch_file(REPO_ROOT)
    if path is None:
        return {"found": False, "file": None, "configs": []}
    try:
        with open(path, encoding="utf-8") as f:
            configs = parse_launch(f.read())
    except OSError:
        return {"found": False, "file": None, "configs": []}
    for c in configs:
        holder = ports_by_number.get(c["port"])
        c["listening"] = holder is not None
        c["holder"] = holder["cmd"] if holder else None
    # The absolute path stays on this machine's page; ~ keeps it short.
    home = os.path.expanduser("~")
    shown = "~" + path[len(home):] if path.startswith(home) else path
    return {"found": True, "file": shown, "configs": configs}


def managed_server():
    """What ./spectro-serve says it manages, read from its own run files."""
    run_dir = os.path.join(REPO_ROOT, ".run")
    out = {"script": "./spectro-serve", "pid": None, "port": None, "running": False}
    try:
        with open(os.path.join(run_dir, "spectro-server.port"), encoding="utf-8") as f:
            out["port"] = int(f.read().strip())
        with open(os.path.join(run_dir, "spectro-server.pid"), encoding="utf-8") as f:
            out["pid"] = int(f.read().strip())
        os.kill(out["pid"], 0)
        out["running"] = True
    except (OSError, ValueError):
        pass
    return out


def gather_estate():
    docker = docker_containers()
    ports = listening_ports()
    ports_by_number = {p["port"]: p for p in ports}
    stacks = gather_stacks(docker)
    servers = gather_servers(ports)
    launch = gather_launch(ports_by_number)

    claims = []
    for c in launch["configs"]:
        claims.append((c["port"], f'launch config {c["name"]}'))
    for s in stacks:
        if s["port"]:
            claims.append((s["port"], f'stack {s["name"]}'))
    for s in servers:
        claims.append((s["port"], f'spectro server :{s["port"]}'))
        if isinstance(s.get("fleet"), dict) and s["fleet"].get("hubPort"):
            claims.append((s["fleet"]["hubPort"], f'fleet hub of server :{s["port"]}'))

    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "docker": {"answering": docker is not None},
        "stacks": stacks,
        "servers": servers,
        "managedServer": managed_server(),
        "launch": launch,
        "collisions": [{"port": p, "claimants": who}
                       for p, who in sorted(collisions(claims).items())],
    }


# ---- the server -------------------------------------------------------------

_cache = {"at": 0.0, "estate": None}
_cache_lock = threading.Lock()


def cached_estate():
    with _cache_lock:
        if time.time() - _cache["at"] > ESTATE_CACHE_SECONDS:
            _cache["estate"] = gather_estate()
            _cache["at"] = time.time()
        return _cache["estate"]


class Handler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=COCKPIT_DIR, **kwargs)

    def log_message(self, fmt, *args):  # quiet: the estate is polled every few seconds
        pass

    def send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/estate":
            self.send_json(200, cached_estate())
            return
        super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] != "/api/act":
            self.send_json(404, {"error": "unknown endpoint"})
            return
        if not origin_ok(self.headers.get("Origin"), self.headers.get("Host", "")):
            self.send_json(403, {"error": "refused: foreign origin"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(min(length, 4096)) or b"{}")
        except (ValueError, TypeError):
            self.send_json(400, {"error": "body must be json"})
            return
        cmd = act_command(req, [s["name"] for s in read_stacks()])
        if cmd is None:
            self.send_json(400, {"error": "refused: only the verbs an existing script has"})
            return
        log_path = os.path.join(REPO_ROOT, "logs", "cockpit-act.log")
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(f"\n--- {time.strftime('%F %T')} {' '.join(cmd)} ---\n")
            log.flush()
            subprocess.Popen(cmd, cwd=REPO_ROOT, stdout=log, stderr=log,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        with _cache_lock:
            _cache["at"] = 0.0   # the next poll re-reads the machine
        self.send_json(202, {"ran": " ".join(cmd), "log": "logs/cockpit-act.log"})


def main():
    port = int(os.environ.get("PORT", "8890"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"cockpit on http://localhost:{port}  (ctrl-c to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
