// Card 585: the fleet hub has a switch and a port, the fleet settings show
// both (the port prefilled with 7700), and the settings and doctor say in
// plain words, EN and DE, which port the hub took and why it is off.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FleetSettings } from "./FleetSettings";
import { DoctorPanel } from "./DoctorPanel";
import {
  checkHubPort,
  hubDoctorRow,
  hubStatusText,
  HUB_DEFAULT_PORT,
  saveHubPort,
  saveSetting,
  type HubState,
  type SettingsState,
} from "./hubSettings";
import { dict, t, type Lang } from "../i18n/i18n";
import { currentLang, setLang } from "../state/lang";

const wasLang = currentLang();
afterAll(() => setLang(wasLang));

const LANGS: Lang[] = ["en", "de"];

function hub(over: Partial<HubState>): HubState {
  return {
    enabledSetting: null,
    portSetting: null,
    on: false,
    port: null,
    pickFrom: 7700,
    note: null,
    reason: null,
    message: "",
    ...over,
  };
}

/** A fetch that answers one port check the way the server does. */
function answering(status: number, body: unknown): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fake = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: fake, urls };
}

const DASHES = /[\u2013\u2014]/;

describe("the hub status in words", () => {
  it("names the port an admin port was swapped for, in both languages", () => {
    const owner = hub({ portSetting: "1", on: true, port: 7700, note: "port-privileged" });
    for (const lang of LANGS) {
      const said = hubStatusText(owner, lang);
      expect(said, lang).toContain("SPECTRO_HUB_PORT=1");
      expect(said, lang).toContain("1024");
      expect(said, lang).toContain("7700");
      expect(said, lang).not.toMatch(DASHES);
    }
    expect(hubStatusText(owner, "de")).not.toBe(hubStatusText(owner, "en"));
  });

  it("says why a written port left the hub off, with the system's reason", () => {
    const held = hub({
      enabledSetting: "true",
      portSetting: "7744",
      note: "bind-failed",
      reason: "Address already in use",
    });
    for (const lang of LANGS) {
      const said = hubStatusText(held, lang);
      expect(said, lang).toContain("7744");
      expect(said, lang).toContain("Address already in use");
      expect(said, lang).not.toMatch(DASHES);
    }
  });

  it("has a sentence for every note the server sends", () => {
    const notes: HubState[] = [
      hub({ on: true, port: 7700 }),
      hub({}),
      hub({ portSetting: "abc", on: true, port: 7700, note: "port-invalid" }),
      hub({ enabledSetting: "true", on: true, port: 7701, note: "default-taken" }),
      hub({ enabledSetting: "true", note: "no-free-port" }),
      hub({ enabledSetting: "maybe", note: "enabled-unreadable" }),
    ];
    for (const lang of LANGS) {
      for (const state of notes) {
        const said = hubStatusText(state, lang);
        expect(said, `${lang} ${state.note}`).not.toMatch(/\{[a-z]+\}/);
        expect(said, `${lang} ${state.note}`).not.toMatch(DASHES);
        expect(said.length).toBeGreaterThan(5);
      }
    }
    expect(hubStatusText(notes[2], "en")).toContain("abc");
    expect(hubStatusText(notes[3], "en")).toContain("7701");
    expect(hubStatusText(notes[5], "en")).toContain("maybe");
  });
});

describe("the doctor row", () => {
  it("reports both settings and the port in use", () => {
    const row = hubDoctorRow(
      hub({ enabledSetting: "true", portSetting: "7744", on: true, port: 7744 }),
      "en",
    );
    expect(row.verdict).toBe("ok");
    expect(row.value).toContain("SPECTRO_HUB_ENABLED=true");
    expect(row.value).toContain("SPECTRO_HUB_PORT=7744");
    expect(row.value).toContain("7744");
  });

  it("warns, with the sentence, when the hub is not what was written", () => {
    for (const lang of LANGS) {
      const row = hubDoctorRow(
        hub({ portSetting: "1", on: true, port: 7700, note: "port-privileged" }),
        lang,
      );
      expect(row.verdict, lang).toBe("warn");
      expect(row.value, lang).toContain("7700");
      expect(row.value, lang).toContain(t(lang, "hub.unset"));
    }
  });

  it("is quiet for a hub nobody turned on, and red when the roster cannot be read", () => {
    expect(hubDoctorRow(hub({}), "en").verdict).toBe("ok");
    expect(hubDoctorRow("failed", "en").verdict).toBe("error");
    expect(hubDoctorRow(null, "en").value).toBe("…");
  });

  it("is a row the panel draws, in both languages", () => {
    for (const lang of LANGS) {
      setLang(lang);
      const html = renderToStaticMarkup(
        <DoctorPanel open={true} onClose={() => {}} status="open" providerInfo={null} permissionMode="ask" />,
      );
      expect(html, lang).toContain(`<span class="doctor-label">${t(lang, "doc.hub")}</span>`);
    }
  });
});

describe("the port field checks before it saves", () => {
  it("saves a blank field without asking, it means the default", async () => {
    const server = answering(200, { free: true });
    expect(await checkHubPort("  ", server.fetch)).toEqual({ kind: "save" });
    expect(server.urls).toEqual([]);
  });

  it("refuses an admin port with the server's reason, in words", async () => {
    const server = answering(400, { reason: "under-1024" });
    const step = await checkHubPort("80", server.fetch);
    expect(step.kind).toBe("refused");
    expect(server.urls).toEqual(["/api/fleet/port-check?port=80"]);
    if (step.kind === "refused") {
      for (const lang of LANGS) expect(t(lang, step.key), lang).toContain("1024");
    }
  });

  it("says a port in use before saving it", async () => {
    const step = await checkHubPort(
      "7744",
      answering(200, { port: 7744, free: false, thisHub: false }).fetch,
    );
    expect(step).toEqual({ kind: "inUse", port: 7744 });
    for (const lang of LANGS) {
      expect(t(lang, "hub.inUse", { port: 7744 }), lang).toContain("7744");
    }
  });

  it("saves a free port, and the port this hub already holds", async () => {
    expect(
      await checkHubPort("7745", answering(200, { port: 7745, free: true, thisHub: false }).fetch),
    ).toEqual({
      kind: "save",
    });
    expect(
      await checkHubPort("7700", answering(200, { port: 7700, free: true, thisHub: true }).fetch),
    ).toEqual({
      kind: "save",
    });
  });
});

describe("the fleet settings", () => {
  it("show the switch and the port field prefilled with 7700, in both languages", () => {
    expect(HUB_DEFAULT_PORT).toBe("7700");
    for (const lang of LANGS) {
      setLang(lang);
      const html = renderToStaticMarkup(<FleetSettings anchorId="fleet" />);
      expect(html, lang).toContain('value="7700"');
      expect(html, lang).toContain(t(lang, "set.hubEnabled"));
      expect(html, lang).toContain(t(lang, "set.hubPort"));
      expect(html, lang).toContain("SPECTRO_HUB_ENABLED");
      expect(html, lang).toContain(`${t(lang, "set.hubEnabled")}</button>`);
    }
    expect(t("de", "set.hubEnabled")).not.toBe(t("en", "set.hubEnabled"));
  });
});

/** A fake server for a sequence of calls: records them and answers from a handler. */
function server(answer: (method: string, url: string, body: unknown) => [number, unknown]): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push(`${method} ${url}${body ? " " + JSON.stringify(body) : ""}`);
    const [status, reply] = answer(method, String(url), body);
    return new Response(JSON.stringify(reply), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: fake, calls };
}

const fresh: SettingsState = {
  SPECTRO_HUB_ENABLED: { value: "", fromEnvironment: false, effective: false },
  SPECTRO_HUB_PORT: { value: "", fromEnvironment: false, default: "7700" },
  SPECTRO_ALLOW_SPAWN: { value: "", fromEnvironment: false },
};

describe("saving keeps the switch and the file in step (review D4)", () => {
  it("a port save also saves the switch as shown, then reads the settings again", async () => {
    const reread: SettingsState = {
      ...fresh,
      SPECTRO_HUB_ENABLED: { value: "false", fromEnvironment: false, effective: false },
      SPECTRO_HUB_PORT: { value: "7745", fromEnvironment: false, default: "7700" },
    };
    const api = server((method) => (method === "GET" ? [200, reread] : [200, { saved: true }]));
    const result = await saveHubPort("7745", fresh, api.fetch);
    expect(api.calls).toEqual([
      'POST /api/settings/env {"name":"SPECTRO_HUB_PORT","value":"7745"}',
      'POST /api/settings/env {"name":"SPECTRO_HUB_ENABLED","value":"false"}',
      "GET /api/settings/env",
    ]);
    expect(result.ok).toBe(true);
    expect(result.settings?.SPECTRO_HUB_ENABLED?.effective).toBe(false);
  });

  it("saves the switch as on when the screen shows it on", async () => {
    const shownOn: SettingsState = {
      ...fresh,
      SPECTRO_HUB_ENABLED: { value: "", fromEnvironment: false, effective: true },
    };
    const api = server((method) => (method === "GET" ? [200, shownOn] : [200, { saved: true }]));
    await saveHubPort("7745", shownOn, api.fetch);
    expect(api.calls[1]).toBe('POST /api/settings/env {"name":"SPECTRO_HUB_ENABLED","value":"true"}');
  });

  it("leaves a switch the environment holds alone", async () => {
    const pinned: SettingsState = {
      ...fresh,
      SPECTRO_HUB_ENABLED: { value: "true", fromEnvironment: true, effective: true },
    };
    const api = server((method) => (method === "GET" ? [200, pinned] : [200, { saved: true }]));
    await saveHubPort("7745", pinned, api.fetch);
    expect(api.calls).toEqual([
      'POST /api/settings/env {"name":"SPECTRO_HUB_PORT","value":"7745"}',
      "GET /api/settings/env",
    ]);
  });

  it("a refused port saves nothing else and names the reason", async () => {
    const api = server(() => [400, { reason: "app-range" }]);
    const result = await saveHubPort("8080", fresh, api.fetch);
    expect(result.ok).toBe(false);
    expect(result.refusedKey).toBe("hub.refuse.app-range");
    expect(api.calls).toHaveLength(1);
  });

  it("every other save reads the settings again too", async () => {
    const after: SettingsState = {
      ...fresh,
      SPECTRO_HUB_ENABLED: { value: "true", fromEnvironment: false, effective: true },
    };
    const api = server((method) => (method === "GET" ? [200, after] : [200, { saved: true }]));
    const result = await saveSetting("SPECTRO_HUB_ENABLED", "true", api.fetch);
    expect(api.calls).toEqual([
      'POST /api/settings/env {"name":"SPECTRO_HUB_ENABLED","value":"true"}',
      "GET /api/settings/env",
    ]);
    expect(result.settings?.SPECTRO_HUB_ENABLED?.effective).toBe(true);
  });

  it("the screen saves through these two and nothing else", () => {
    const screen = readFileSync(fileURLToPath(new URL("./FleetSettings.tsx", import.meta.url)), "utf8");
    expect(screen).toContain("saveHubPort(");
    expect(screen).not.toContain('fetch("/api/settings/env", {');
  });
});

describe("the fleet screen speaks without dashes (review N6)", () => {
  it("has no em or en dash in any of its strings, EN and DE", () => {
    const keys = Object.keys(dict).filter(
      (k) =>
        k.startsWith("hub.") ||
        [
          "set.secFleet",
          "set.fleetHint",
          "set.hubEnabled",
          "set.hubPort",
          "set.allowSpawn",
          "set.allowSpawnWhat",
          "set.allowSpawnWarn",
          "set.envWins",
          "set.restartNeeded",
          "set.saveFailed",
          "doc.hub",
          "doc.hubOn",
          "doc.hubOff",
        ].includes(k),
    );
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      for (const lang of LANGS) expect(t(lang, key), `${lang} ${key}`).not.toMatch(DASHES);
    }
  });
});

describe("every server answer has words here", () => {
  const java = readFileSync(
    fileURLToPath(
      new URL(
        "../../../spectro-orchestrator/src/main/java/dev/spectroscope/orchestrator/HubSettings.java",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  it("names every note the server can send in its own sentence", () => {
    const body = java.slice(java.indexOf("public enum Note {"), java.indexOf("public String wire()"));
    const notes = [...body.matchAll(/^\s{8}([A-Z_]+)[,;]/gm)].map((m) =>
      m[1].toLowerCase().replace(/_/g, "-"),
    );
    expect(notes.length).toBeGreaterThan(8);
    for (const note of notes.filter((n) => n !== "none")) {
      const state = hub({ note, portSetting: "8080", port: 7700, on: true, message: "SERVER WORDS" });
      for (const lang of LANGS) {
        const said = hubStatusText(state, lang);
        expect(said, `${lang} ${note}`).not.toBe("SERVER WORDS");
        expect(said, `${lang} ${note}`).not.toMatch(/\{[a-z]+\}/);
      }
    }
  });

  it("has a refusal sentence for every reason the server refuses with", () => {
    const body = java.slice(java.indexOf("public static String refusal("));
    const reasons = [...body.slice(0, body.indexOf("default ->")).matchAll(/case "([a-z0-9-]+)"/g)].map(
      (m) => m[1],
    );
    expect(reasons.length).toBeGreaterThan(2);
    for (const reason of [...reasons, "not-a-port"]) {
      expect(dict[`hub.refuse.${reason}`], reason).toBeDefined();
    }
  });
});
