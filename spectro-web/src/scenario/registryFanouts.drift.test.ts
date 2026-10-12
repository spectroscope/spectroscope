// Card 506, fix round 1: the workflow reader takes the scenario DSL's
// `fanout:` step. Java pins that conversion on a fixture
// (spectro-core/src/test/resources/playbook/registry-fanouts.json,
// WorkflowRegistryFanoutsTest); this file holds the fixture to every
// `fanout:` step of the registry, so a new or changed step turns red here
// until the fixture is written again.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./registry";

const FIXTURE = "spectro-core/src/test/resources/playbook/registry-fanouts.json";

/** Every fan-out step of the registry as a workflow file of that step and an end, named by its scenario. */
function fanoutDocs(): { name: string; steps: unknown[] }[] {
  const docs: { name: string; steps: unknown[] }[] = [];
  for (const s of SCENARIOS) {
    const fanouts = s.steps.filter((step) => "fanout" in step);
    fanouts.forEach((step, i) =>
      docs.push({ name: fanouts.length > 1 ? `${s.id}-${i + 1}` : s.id, steps: [step, { end: {} }] }),
    );
  }
  return docs;
}

describe("registry fan-outs fixture", () => {
  it("holds every fanout step of the registry, in order, equal as parsed JSON", () => {
    const fixture: unknown = JSON.parse(
      readFileSync(fileURLToPath(new URL(`../../../${FIXTURE}`, import.meta.url)), "utf8"),
    );
    const docs = fanoutDocs();
    expect(docs.length).toBeGreaterThan(0);
    expect(fixture).toEqual(JSON.parse(JSON.stringify(docs)));
  });
});
