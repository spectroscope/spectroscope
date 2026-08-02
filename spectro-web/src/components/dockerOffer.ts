// What the Observability settings offer once /api/docker/status has answered
// (card 137). Pure on purpose: the decision is the part worth pinning, and a
// wrong decision here is a user told to re-download software they already have.
//
// spectroscope never runs any of this. The app prints a command; the operator
// reads it and runs it. That asymmetry is the whole design: a process that can
// reach the Docker socket can bind-mount any host path into a container, which
// is read and write access to the entire disk.

/** The server's read-only answer. Mirrors DockerStatusController's JSON. */
export type DockerStatus = {
  /** absent = nothing installed; unreachable = installed, daemon silent; ready = daemon answered. */
  docker: "absent" | "unreachable" | "ready";
  /** Whether the compose v2 CLI plugin is installed. */
  compose: boolean;
  /** Whether DOCKER_HOST names a daemon on another machine. */
  remote: boolean;
  /** One honest sentence from the server, never a stack trace. */
  detail?: string;
};

/** What the settings block should render. */
export type DockerOffer = {
  /**
   * unknown  nothing has answered yet, render nothing
   * install  no Docker at all, offer the download page
   * start    Docker is installed and the daemon is down, say exactly that
   * compose  daemon is up but the compose plugin is missing
   * remote   the configured daemon is not on this machine
   * run      hand over the command
   */
  kind: "unknown" | "install" | "start" | "compose" | "remote" | "run";
  /** The i18n key for the line. Distinct per kind so the copy cannot blur. */
  messageKey: string;
  /** The download page. Only ever set for "install". */
  href?: string;
  /** The command to copy. Only ever set for "run". */
  command?: string;
};

/** Where Docker Desktop is downloaded. Verified to resolve, 2026-08-02. */
const DOCKER_DOWNLOAD = "https://www.docker.com/products/docker-desktop/";

/** The shipped stack, relative to the repository root. Pinned here because the
 *  command below is only true while this path exists; dockerOffer.test.ts reads
 *  it off disk so a moved sample fails the suite instead of the user. */
export const LANGFUSE_SAMPLE_PATH = "samples/06-langfuse";

/**
 * The command handed to an operator whose daemon is ready.
 *
 * It points at the stack this repository ships rather than at Langfuse's own
 * compose file, because the shipped one closes both first-boot traps in the
 * file itself and generates its own secrets. Upstream's example boots with the
 * passwords printed in its documentation.
 *
 * Deliberately not a curl-pipe-shell one liner. The operator gets a repository
 * they can read before anything executes, and the installer they run is the
 * same file the drift tests here assert against.
 */
export const LANGFUSE_COMPOSE_COMMAND = [
  "git clone --depth 1 https://github.com/spectroscope/spectroscope.git",
  `cd spectroscope/${LANGFUSE_SAMPLE_PATH} && ./install.sh`,
].join("\n");

/**
 * Decide what to offer for a Docker status.
 *
 * @param status the server's answer, or null before it has arrived
 * @returns the offer; `href` only for "install", `command` only for "run"
 */
export function dockerOffer(status: DockerStatus | null | undefined): DockerOffer {
  if (!status) {
    return { kind: "unknown", messageKey: "set.dockerUnknown" };
  }
  // Remote is checked before anything else: a daemon on another machine cannot
  // be started from here, and its containers would not answer on localhost, so
  // neither the start line nor the run command would be true.
  if (status.remote) {
    return { kind: "remote", messageKey: "set.dockerRemote" };
  }
  if (status.docker === "absent") {
    return { kind: "install", messageKey: "set.dockerAbsent", href: DOCKER_DOWNLOAD };
  }
  if (status.docker === "unreachable") {
    // Installed, not running. Never the install offer: this operator has Docker.
    return { kind: "start", messageKey: "set.dockerDown" };
  }
  if (!status.compose) {
    // A daemon without the compose plugin cannot run the stack, so printing a
    // compose line here would be the same broken promise in a different costume.
    return { kind: "compose", messageKey: "set.dockerNoCompose" };
  }
  return { kind: "run", messageKey: "set.dockerReady", command: LANGFUSE_COMPOSE_COMMAND };
}
