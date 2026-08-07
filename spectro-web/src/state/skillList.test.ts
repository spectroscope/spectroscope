import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSkillList, loadSkills, loadedSkills } from "./skillList";

let fetchMock: ReturnType<typeof vi.fn>;

function answer(body: unknown, status = 200): void {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  __resetSkillList();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("loading the installed skills", () => {
  it("asks once however often it is wanted", async () => {
    // The composer asks on every keystroke that starts with a slash.
    answer({ skills: [{ name: "verification", folder: "verification", pack: null, description: "d" }] });

    loadSkills();
    loadSkills();
    loadSkills();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/skills");
    expect(loadedSkills().map((s) => s.name)).toEqual(["verification"]);
  });

  it("reads the pack and folder a namespaced install sends", async () => {
    answer({
      skills: [
        { name: "superpowers:brainstorming", folder: "brainstorming", pack: "superpowers", description: "d" },
      ],
    });

    loadSkills();
    await flush();

    expect(loadedSkills()[0]).toEqual({
      name: "superpowers:brainstorming",
      folder: "brainstorming",
      pack: "superpowers",
      description: "d",
      disabled: false,
    });
  });

  it("derives both from the name when an older server sends neither", async () => {
    // A server from before the namespace lists a bare name and no pack. Reading
    // it this way is why the composer works against one instead of drawing a
    // list of undefined.
    answer({ skills: [{ name: "superpowers:writing-plans", description: "d" }, { name: "verification" }] });

    loadSkills();
    await flush();

    expect(loadedSkills()).toEqual([
      {
        name: "superpowers:writing-plans",
        folder: "writing-plans",
        pack: "superpowers",
        description: "d",
        disabled: false,
      },
      { name: "verification", folder: "verification", pack: null, description: "", disabled: false },
    ]);
  });

  it("carries the off switch through, so the completion can leave it out", async () => {
    answer({ skills: [{ name: "quiet", disabled: true }] });

    loadSkills();
    await flush();

    expect(loadedSkills()[0].disabled).toBe(true);
  });

  it("drops a row with no name rather than listing a blank", async () => {
    answer({ skills: [{ description: "no name" }, { name: "" }, { name: "real" }] });

    loadSkills();
    await flush();

    expect(loadedSkills().map((s) => s.name)).toEqual(["real"]);
  });

  it("ends up with nothing, not an exception, when the server refuses", async () => {
    answer({}, 404);

    loadSkills();
    await flush();

    expect(loadedSkills()).toEqual([]);
  });

  it("ends up with nothing when the answer is not the shape it promised", async () => {
    answer({ skills: "not a list" });

    loadSkills();
    await flush();

    expect(loadedSkills()).toEqual([]);
  });

  it("does not ask again after a failure", async () => {
    // A composer that retried per keystroke would hammer a server that is down.
    fetchMock.mockRejectedValue(new Error("offline"));

    loadSkills();
    await flush();
    loadSkills();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
