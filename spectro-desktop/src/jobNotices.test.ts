import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { cronJobs, isCodeGraphJob, jobNotice } from "./jobNotices";
import { cronLabel, trayTooltip } from "./menuModel";

// Card 472: GET /api/jobs/state carries code graph builds beside the cron
// jobs, under ids "codegraph:<folder>". The shell must not call a build a
// cron job, and the tray's cron count must stay a count of cron jobs.
const FOLDER = "/home/someone/projects/app";

describe("code graph entries in the jobs state", () => {
  it("knows a build by its id prefix and nothing else", () => {
    assert.equal(isCodeGraphJob(`codegraph:${FOLDER}`), true);
    assert.equal(isCodeGraphJob("nightly-report"), false);
    assert.equal(isCodeGraphJob("my-codegraph:job"), false);
  });

  it("keeps only the cron jobs for the tray", () => {
    const jobs = { nightly: "ok", [`codegraph:${FOLDER}`]: "running" };
    assert.deepEqual(cronJobs(jobs), { nightly: "ok" });
  });

  it("does not count a running build as a running cron job", () => {
    const jobs = { nightly: "ok", [`codegraph:${FOLDER}`]: "running" };
    assert.equal(cronLabel(jobs), "Cron · 1 job");
    assert.equal(cronLabel({ [`codegraph:${FOLDER}`]: "ok" }), "Cron status");
  });

  it("leaves builds out of the tooltip's cron count", () => {
    const tip = trayTooltip("spectroscope", { port: 8080, serverUp: true, jobs: { [`codegraph:${FOLDER}`]: "ok" } });
    assert.equal(tip, "spectroscope · 127.0.0.1:8080 · no cron jobs yet");
  });
});

describe("jobNotice", () => {
  it("raises nothing when a build starts: the header already says so", () => {
    assert.equal(jobNotice(`codegraph:${FOLDER}`, { status: "running", sessionId: "s1" }), null);
  });

  it("raises nothing when a build ends either: the header chip is the one signal (owner, 2026-10-09)", () => {
    for (const status of ["ok", "failed", "unknown"]) {
      assert.equal(jobNotice(`codegraph:${FOLDER}`, { status, sessionId: "s1" }), null, status);
    }
  });

  it("keeps the cron job notice as it was", () => {
    assert.deepEqual(jobNotice("nightly", { status: "ok", sessionId: "s1" }), {
      title: 'Cron job "nightly" ok',
      body: "Click to open the session.",
    });
    assert.deepEqual(jobNotice("nightly", { status: "failed" }), {
      title: 'Cron job "nightly" failed',
      body: "failed",
    });
  });
});
