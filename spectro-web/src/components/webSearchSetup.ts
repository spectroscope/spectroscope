// What the Web search settings block offers once /api/docker/status has
// answered (card 203). Pure on purpose, exactly like dockerOffer next door:
// the decision is the part worth pinning, and the command is a promise about a
// file that has to keep existing.
//
// spectroscope never runs any of this. The app prints a command; the operator
// reads it and runs it. Same asymmetry, same reason: a process that can reach
// the Docker socket can bind-mount any host path into a container.

import { dockerOffer, type DockerOffer, type DockerStatus } from "./dockerOffer";

/** The shipped setup, relative to the repository root. Pinned here because the
 *  command below is only true while this path exists; webSearchSetup.test.ts
 *  reads it off disk so a moved sample fails the suite instead of the user. */
export const SEARXNG_SAMPLE_PATH = "samples/07-searxng";

/**
 * The command handed to an operator whose daemon is ready.
 *
 * <p>It is not a `docker run` line, and it cannot be one. Stock SearXNG lists
 * only `html` under `search.formats` and answers HTTP 403 to every request for
 * a format that is not on that list — so the obvious one-liner produces a
 * perfectly good search page and an API that hands this product nothing back
 * (measured against the real image, 2026-08-13). The shipped installer writes
 * the settings file that turns `json` on, generates the instance's secret key,
 * and then waits for a real `format=json` query to come back with results
 * rather than for the port to open.</p>
 *
 * <p>Same shape as the Langfuse offer beside it, deliberately: the operator
 * gets a repository they can read before anything executes, and the script they
 * run is the same file the drift test here asserts against.</p>
 */
export const SEARXNG_INSTALL_COMMAND = [
  "git clone --depth 1 https://github.com/spectroscope/spectroscope.git",
  `cd spectroscope/${SEARXNG_SAMPLE_PATH} && ./install.sh`,
].join("\n");

/**
 * Decide what the Web search block should offer for a Docker status.
 *
 * The state machine is dockerOffer's — "is Docker usable on this machine" has
 * one answer, and a second copy of that reasoning would be a second thing to
 * get wrong (the install-versus-start distinction in particular, which exists
 * so nobody is told to re-download software they already have). What this
 * function replaces is the two sentences that name a stack: this block is
 * offering SearXNG, not Langfuse.
 *
 * @param status the server's answer, or null before it has arrived
 * @returns the offer; `href` only for "install", `command` only for "run"
 */
export function searxngOffer(status: DockerStatus | null | undefined): DockerOffer {
  const shared = dockerOffer(status);
  if (shared.kind === "run") {
    return { ...shared, messageKey: "set.searxngDockerReady", command: SEARXNG_INSTALL_COMMAND };
  }
  if (shared.kind === "install") {
    return { ...shared, messageKey: "set.searxngDockerAbsent" };
  }
  return shared;
}
