// Card 495: the sign-in sheet's client half. The status comes from
// GET /api/copilot/account; the writes post JSON, which is what the server's
// fence takes (a form post is refused there).

import { afterEach, describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import {
  accountLine,
  afterRead,
  COPILOT_KEYS,
  fetchCopilotAccount,
  pollDelayMs,
  postCopilotAccount,
  type CopilotAccountStatus,
} from "./copilotAccount";

const base: CopilotAccountStatus = {
  state: "NOT_SIGNED_IN",
  method: null,
  login: null,
  userCode: null,
  verificationUri: null,
  expiresAt: 0,
  message: null,
  github: true,
  cli: true,
};

type Call = { url: string; init?: RequestInit };

function fakeFetch(body: unknown, status = 200): { calls: Call[]; fn: typeof fetch } {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fn };
}

afterEach(() => undefined);

describe("the provider status line", () => {
  it("names the login when signed in, in both languages", () => {
    const signedIn = { ...base, state: "SIGNED_IN" as const, method: "github", login: "octo-fixture" };
    expect(accountLine(signedIn, "en")).toBe("Signed in as octo-fixture");
    expect(accountLine(signedIn, "de")).toBe("Angemeldet als octo-fixture");
  });

  it("says not signed in for nothing stored and for a refusal", () => {
    expect(accountLine(base, "en")).toBe("Not signed in");
    expect(
      accountLine({ ...base, state: "REFUSED", message: "The authorization request was denied." }, "en"),
    ).toBe("Not signed in");
  });

  it("says it is reading before the first answer, and that the read failed after a failed one", () => {
    expect(accountLine(undefined, "en")).toBe(dict["cp.loading"].en);
    expect(accountLine(null, "en")).toBe(dict["cp.unreachable"].en);
    expect(accountLine(null, "en")).not.toBe("Not signed in");
  });

  it("says it waits while a code is out", () => {
    const waiting = { ...base, state: "WAITING" as const, userCode: "WXYZ-9876" };
    expect(accountLine(waiting, "en")).toBe(dict["cp.waiting"].en);
    expect(accountLine(waiting, "en")).not.toContain("WXYZ-9876");
  });
});

describe("polling", () => {
  it("polls only while a sign-in waits", () => {
    expect(pollDelayMs({ ...base, state: "WAITING" })).toBe(2000);
    for (const state of ["NOT_SIGNED_IN", "SIGNED_IN", "REFUSED"] as const) {
      expect(pollDelayMs({ ...base, state })).toBeNull();
    }
    expect(pollDelayMs(null)).toBeNull();
    expect(pollDelayMs(undefined)).toBeNull();
  });

  it("keeps the last status and goes on polling, slower, when one read fails", () => {
    const waiting = { ...base, state: "WAITING" as const, userCode: "WXYZ-9876" };
    const failed = afterRead({ status: waiting, failures: 0 }, null);
    expect(failed.status).toBe(waiting);
    expect(failed.failures).toBe(1);
    expect(pollDelayMs(failed.status, failed.failures)).toBe(4000);
    expect(pollDelayMs(waiting, 20)).toBe(10000);

    const signedIn = { ...base, state: "SIGNED_IN" as const, login: "octo-fixture" };
    const read = afterRead(failed, signedIn);
    expect(read).toEqual({ status: signedIn, failures: 0 });
  });

  it("shows a failed first read as a failed read", () => {
    expect(afterRead({ status: undefined, failures: 0 }, null)).toEqual({ status: null, failures: 1 });
  });
});

describe("the wire", () => {
  it("reads the status from the account endpoint", async () => {
    const f = fakeFetch({ ...base, state: "SIGNED_IN", login: "octo-fixture" });
    const status = await fetchCopilotAccount(f.fn);
    expect(f.calls[0].url).toBe("/api/copilot/account");
    expect(status?.login).toBe("octo-fixture");
  });

  it("answers null when the server refuses or is gone", async () => {
    expect(await fetchCopilotAccount(fakeFetch({}, 404).fn)).toBeNull();
    const broken = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchCopilotAccount(broken)).toBeNull();
  });

  it("posts JSON to the action's path", async () => {
    const f = fakeFetch({ ...base, state: "WAITING", userCode: "WXYZ-9876" });
    await postCopilotAccount("sign-in", { method: "github" }, f.fn);
    await postCopilotAccount("sign-out", {}, f.fn);
    expect(f.calls.map((c) => c.url)).toEqual([
      "/api/copilot/account/sign-in",
      "/api/copilot/account/sign-out",
    ]);
    expect(f.calls[0].init?.method).toBe("POST");
    expect(new Headers(f.calls[0].init?.headers).get("Content-Type")).toBe("application/json");
    expect(f.calls[0].init?.body).toBe('{"method":"github"}');
    expect(f.calls[0].url).not.toContain("WXYZ");
  });
});

describe("the dictionary", () => {
  it("has every key the sheet uses, in both languages, with no dash", () => {
    expect(COPILOT_KEYS.length).toBeGreaterThanOrEqual(15);
    for (const key of COPILOT_KEYS) {
      expect(dict[key], key).toBeDefined();
      for (const lang of ["en", "de"] as const) {
        expect(dict[key][lang].length, `${key} ${lang}`).toBeGreaterThan(0);
        expect(dict[key][lang], `${key} ${lang}`).not.toMatch(/[–—]| -- /);
      }
    }
  });
});
