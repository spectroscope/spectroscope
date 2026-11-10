// Card 605: the level of a path the session touched (design section 2 and
// call B1). Paths arrive as the files tab's fold resolved them: absolute where
// a base was known, otherwise as written.

import { describe, expect, it } from "vitest";
import { higher, isSecretPath, LEVEL_ORDER, outsideWorkspace, pathLevel } from "./levels";

const SECRETS = [
  ".env",
  "/w/.env.local",
  "/w/certs/server.pem",
  "/w/a.key",
  "x.p12",
  "x.pfx",
  "x.keystore",
  "x.jks",
  "vault.kdbx",
  "~/.ssh/id_ed25519",
  "/u/.ssh/config",
  "/u/.aws/credentials",
  "/u/.gnupg/pubring.kbx",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  "credentials.json",
  "secrets.yaml",
  "kubeconfig",
];

const TEMPLATES = [
  "/w/.env.example",
  "/w/.env.sample",
  "/w/.env.template",
  "/w/.env.dist",
  "/w/.env.defaults",
];

describe("pathLevel", () => {
  it("secret names and folders are critical", () => {
    for (const p of SECRETS) {
      expect(pathLevel(p, "/w"), p).toBe("critical");
      expect(pathLevel(p, null), p).toBe("critical");
      expect(isSecretPath(p), p).toBe(true);
    }
    // *.key stays critical, though Keynote documents share the extension.
    expect(pathLevel("/w/server.key", "/w")).toBe("critical");
  });

  it("source and prose named after secrets stay project", () => {
    for (const p of [
      "src/files/secrets.ts",
      "src/files/secrets.test.ts",
      "app/secrets/vault.py",
      "docs/credentials.md",
    ]) {
      expect(pathLevel(p, "/w"), p).toBe("project");
      expect(pathLevel(`/w/${p}`, "/w"), p).toBe("project");
      expect(pathLevel(p, null), p).toBe("project");
      expect(isSecretPath(p), p).toBe(false);
    }
    const data = [
      "secrets.yaml",
      "secrets.json",
      "credentials.json",
      "credentials.yaml",
      "credentials",
      "secrets/prod.env",
      "credentials/token.txt",
    ];
    for (const p of data) {
      expect(pathLevel(p, "/w"), p).toBe("critical");
      expect(pathLevel(p, null), p).toBe("critical");
    }
  });

  it("a key store folder is critical whatever the extension", () => {
    for (const p of [
      "/u/.ssh/helper.py",
      "~/.aws/notes.md",
      "/u/.gnupg/agent.ts",
      "/Users/a/Library/Keychains/x.js",
    ]) {
      expect(pathLevel(p, "/w"), p).toBe("critical");
      expect(pathLevel(p, null), p).toBe("critical");
    }
  });

  it("a public key is never critical", () => {
    for (const p of ["~/.ssh/id_rsa.pub", "/u/.ssh/id_ed25519.pub"]) {
      expect(pathLevel(p, "/w"), p).toBe("sensitive");
      expect(isSecretPath(p), p).toBe(false);
    }
    expect(pathLevel("~/.ssh/id_rsa.pub", null)).toBe("sensitive");
    expect(pathLevel("/w/keys/deploy.pub", "/w")).toBe("project");
    expect(pathLevel("~/.ssh/id_rsa", "/w")).toBe("critical");
  });

  it("templates stay project", () => {
    for (const p of TEMPLATES) {
      expect(pathLevel(p, "/w"), p).toBe("project");
      expect(isSecretPath(p), p).toBe(false);
    }
  });

  it("a key file outside .ssh is critical by its name", () => {
    for (const p of ["/w/deploy/id_rsa", "/w/id_ed25519_sk", "/w/keys/id_ecdsa.old", "/w/id_dsa"]) {
      expect(pathLevel(p, "/w"), p).toBe("critical");
    }
    expect(pathLevel("/w/src/identity.ts", "/w")).toBe("project");
  });

  it("case does not hide a secret name", () => {
    for (const p of [
      "/w/.ENV.local",
      "/w/certs/Server.PEM",
      "/Users/a/Library/Keychains/login.keychain-db",
    ]) {
      expect(pathLevel(p, "/w"), p).toBe("critical");
      expect(pathLevel(p, null), p).toBe("critical");
    }
  });

  it("outside the workspace is sensitive", () => {
    const ws = "/Users/a/p";
    for (const p of ["/Users/a/q/x.ts", "/Users/a/.zsh_history", "/etc/hosts", "~/notes.md"]) {
      expect(pathLevel(p, ws), p).toBe("sensitive");
    }
    expect(pathLevel("/Users/a/p/src/x.ts", ws)).toBe("project");
    expect(pathLevel("/Users/a/p", ws)).toBe("project");
    expect(pathLevel("/Users/a/p2/x", ws)).toBe("sensitive");
  });

  it("without a workspace only system folders and home dot folders are sensitive", () => {
    const sensitive = [
      "/etc/hosts",
      "/var/log/x",
      "/private/tmp/x",
      "/tmp/x",
      "/usr/local/x",
      "/Library/x",
      "/System/x",
      "/Users/a/.zshrc",
      "/home/a/.config/x",
      "~/.bash_history",
    ];
    for (const p of sensitive) expect(pathLevel(p, null), p).toBe("sensitive");
    for (const p of ["/Users/a/p/src/x.ts", "src/x.ts", "/"]) expect(pathLevel(p, null), p).toBe("project");
  });

  it("system and home folder names ignore case", () => {
    expect(pathLevel("/library/x", null)).toBe("sensitive");
    expect(pathLevel("/users/a/.zshrc", null)).toBe("sensitive");
  });

  it("a home folder's dot files stay sensitive in a workspace that holds the home folder", () => {
    for (const ws of ["/Users/a", "/Users"]) {
      expect(pathLevel("/Users/a/.zsh_history", ws), ws).toBe("sensitive");
      expect(pathLevel("/Users/a/.config/gh/hosts.yml", ws), ws).toBe("sensitive");
      expect(pathLevel("/Users/a/notes.md", ws), ws).toBe("project");
    }
    expect(pathLevel("~/.zshrc", "~")).toBe("sensitive");
    // A workspace inside the dot folder keeps its own files project.
    expect(pathLevel("/Users/a/.config/nvim/init.lua", "/Users/a/.config/nvim")).toBe("project");
  });

  it("a folded path and a trailing slash do not move the border", () => {
    expect(pathLevel("/Users/a/p/src/x.ts", "/Users/a/p/")).toBe("project");
    expect(pathLevel("/Users/a/p/", "/Users/a/p")).toBe("project");
    expect(pathLevel("/Users/a/p/./src/x.ts", "/Users/a/p")).toBe("project");
    expect(pathLevel("/Users/a/p/../q/x", "/Users/a/p")).toBe("sensitive");
    expect(pathLevel("/Users/a/./p/x.ts", null)).toBe("project");
    expect(pathLevel("/Users/a/p/../.zshrc", null)).toBe("sensitive");
  });

  it("a workspace that cannot be placed counts as none", () => {
    for (const ws of ["", "/", "proj"]) {
      expect(pathLevel("/etc/hosts", ws), ws).toBe("sensitive");
      expect(pathLevel("/Users/a/q/x.ts", ws), ws).toBe("project");
      expect(outsideWorkspace("/Users/a/q/x.ts", ws), ws).toBe(false);
    }
  });
});

describe("outsideWorkspace", () => {
  it("judges only a rooted path against a known workspace", () => {
    const ws = "/Users/a/p";
    expect(outsideWorkspace("/Users/a/q/x.ts", ws)).toBe(true);
    expect(outsideWorkspace("~/notes.md", ws)).toBe(true);
    expect(outsideWorkspace("~", ws)).toBe(true);
    expect(pathLevel("~", ws)).toBe("sensitive");
    expect(outsideWorkspace("/Users/a/p/src/x.ts", ws)).toBe(false);
    expect(outsideWorkspace("/Users/a/p", ws)).toBe(false);
    expect(outsideWorkspace("src/x.ts", ws)).toBe(false);
    expect(outsideWorkspace("../q/x", ws)).toBe(false);
    expect(outsideWorkspace("/etc/hosts", null)).toBe(false);
  });
});

describe("higher", () => {
  it("higher picks the earlier level of LEVEL_ORDER", () => {
    expect(LEVEL_ORDER).toEqual(["critical", "sensitive", "unknown", "project"]);
    expect(higher("project", "critical")).toBe("critical");
    expect(higher("sensitive", "unknown")).toBe("sensitive");
    expect(higher("project", "unknown")).toBe("unknown");
    expect(higher("project", "project")).toBe("project");
    for (const [i, a] of LEVEL_ORDER.entries()) {
      for (const [j, b] of LEVEL_ORDER.entries()) {
        expect(higher(a, b), `${a} ${b}`).toBe(LEVEL_ORDER[Math.min(i, j)]);
      }
    }
  });
});
