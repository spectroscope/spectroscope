// What the Observability settings offer once the server has reported Docker's
// state (card 137). The decision is pure so it can be pinned without a DOM, and
// the assertion that earns this file is the second one: an installed Docker with
// a dead daemon must never be described as a missing install, because that sends
// the operator off to re-download software they already have.

import { describe, expect, it } from "vitest";
import { LANGFUSE_COMPOSE_COMMAND, dockerOffer, type DockerStatus } from "./dockerOffer";

const status = (over: Partial<DockerStatus>): DockerStatus => ({
  docker: "ready",
  compose: true,
  remote: false,
  detail: "",
  ...over,
});

describe("dockerOffer", () => {
  it("offers the install only when docker is absent", () => {
    expect(dockerOffer(status({ docker: "absent" })).href).toBeDefined();
    expect(dockerOffer(status({ docker: "unreachable" })).href).toBeUndefined();
    expect(dockerOffer(status({ docker: "ready" })).href).toBeUndefined();
    expect(dockerOffer(status({ docker: "ready", remote: true })).href).toBeUndefined();
    expect(dockerOffer(null).href).toBeUndefined();
  });

  it("never calls a dead daemon a missing install", () => {
    const offer = dockerOffer(status({ docker: "unreachable" }));
    expect(offer.kind).toBe("start");
    expect(offer.messageKey).not.toBe(dockerOffer(status({ docker: "absent" })).messageKey);
    expect(offer.href).toBeUndefined();
  });

  it("offers the command only when the daemon answers", () => {
    expect(dockerOffer(status({ docker: "ready" })).kind).toBe("run");
    expect(dockerOffer(status({ docker: "ready" })).command).toBe(LANGFUSE_COMPOSE_COMMAND);
    expect(dockerOffer(status({ docker: "unreachable" })).command).toBeUndefined();
    expect(dockerOffer(status({ docker: "absent" })).command).toBeUndefined();
  });

  it("a remote daemon gets no local offer", () => {
    // A daemon on another machine cannot be started by a command pasted here,
    // and its containers would not be on localhost either.
    const offer = dockerOffer(status({ docker: "ready", remote: true }));
    expect(offer.kind).toBe("remote");
    expect(offer.kind).not.toBe("run");
    expect(offer.command).toBeUndefined();
  });

  it("null status renders nothing", () => {
    expect(dockerOffer(null).kind).toBe("unknown");
    expect(dockerOffer(null).command).toBeUndefined();
  });

  it("withholds the command when the compose plugin is missing", () => {
    // docker without compose cannot run the stack, so printing a compose line
    // would be the same broken promise in a different costume.
    const offer = dockerOffer(status({ docker: "ready", compose: false }));
    expect(offer.kind).toBe("compose");
    expect(offer.command).toBeUndefined();
  });

  it("the offered command starts the stack and nothing else", () => {
    // spectroscope never runs this. The whole point of handing over a string is
    // that the operator reads it before it executes.
    expect(LANGFUSE_COMPOSE_COMMAND).toContain("docker compose up");
    expect(LANGFUSE_COMPOSE_COMMAND).not.toContain("docker-compose ");
    expect(LANGFUSE_COMPOSE_COMMAND).not.toContain("sudo");
    expect(LANGFUSE_COMPOSE_COMMAND).not.toContain("curl ");
    expect(LANGFUSE_COMPOSE_COMMAND).not.toContain("| sh");
  });
});
