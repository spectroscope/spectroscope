import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { quitQuestion, runningCount } from "./quitGuard";

// Card 459, owner call 4: the desktop app warns on quit while sessions are
// running. The server's live set (GET /api/sessions/live) is the source.
describe("runningCount", () => {
  it("counts the sessions whose run is in flight, not the ones merely held", () => {
    const body = [
      { id: "a", running: true, since: 1 },
      { id: "b", running: false, since: 2 },
      { id: "c", running: true, since: 3 },
    ];
    assert.equal(runningCount(body), 2);
  });

  it("reads anything that is not the live set as nothing running", () => {
    assert.equal(runningCount(null), 0);
    assert.equal(runningCount({ running: true }), 0);
    assert.equal(runningCount([{ running: "yes" }]), 0);
  });
});

describe("quitQuestion", () => {
  it("asks when two sessions are still working, and names the number", () => {
    const q = quitQuestion(2);
    assert.ok(q !== null);
    assert.equal(q.message, "2 sessions are still working. Quit anyway?");
    assert.deepEqual(q.buttons, ["Quit", "Cancel"]);
    assert.equal(q.cancelId, 1);
    assert.match(q.detail, /history/);
  });

  it("says one session in the singular", () => {
    assert.equal(quitQuestion(1)?.message, "1 session is still working. Quit anyway?");
  });

  it("does not ask when nothing runs", () => {
    assert.equal(quitQuestion(0), null);
  });
});
