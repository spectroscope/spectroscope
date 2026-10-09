// Card 430, criterion 9: spectrum, trace, graph, text, lab, the fleet surfaces
// and the state graph view load from their own chunks, and the entry chunk
// imports none of them statically.
//
// The guard builds the app with the project's own vite.config.ts, in memory
// (nothing is written, least of all the tracked bundle), reads the build
// manifest out of the output, and takes the list of modules from the surface
// table. A static import of one of them from anywhere the entry reaches puts
// the module into the entry chunk; it then has no chunk of its own, and this
// turns red.
//
// The split must not move a stylesheet either. Vite hands the CSS a lazy chunk
// imports to its own asset and appends that to <head> after the entry's
// stylesheet, so a sheet that sat before app.css in the entry would land after
// it and win every tie. That happened to @xyflow/react's style.css in the first
// build of this card: its `.react-flow__edge-path` stroke and its
// `.react-flow__controls` shadow beat the app's own rules of the same selector.
// The last describe block below holds both halves of that.

import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";
import { SURFACES, type SurfaceId } from "./surfaces";

const WEB = fileURLToPath(new URL("../..", import.meta.url));

interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}
type Manifest = Record<string, ManifestChunk>;

let manifest: Manifest = {};
let chunks: Rollup.OutputChunk[] = [];
/** Every stylesheet the build wrote, by file name. */
let stylesheets = new Map<string, string>();

beforeAll(async () => {
  const out = (await build({
    root: WEB,
    configFile: `${WEB}vite.config.ts`,
    logLevel: "silent",
    // The manifest comes from vite.config.ts itself (criterion 9 switches it on there).
    build: { write: false, outDir: `${WEB}node_modules/.tmp/chunk-guard` },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const files = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output);
  const asset = files.find(
    (file): file is Rollup.OutputAsset => file.type === "asset" && file.fileName === ".vite/manifest.json",
  );
  if (asset === undefined) throw new Error("the build wrote no manifest; vite.config.ts must switch it on");
  manifest = JSON.parse(String(asset.source)) as Manifest;
  chunks = files.filter((file): file is Rollup.OutputChunk => file.type === "chunk");
  stylesheets = new Map(
    files
      .filter((file): file is Rollup.OutputAsset => file.type === "asset" && file.fileName.endsWith(".css"))
      .map((file) => [file.fileName, String(file.source)]),
  );
}, 120_000);

/** Every surface the table puts in a chunk of its own, with its modules. */
const CHUNKED = (Object.keys(SURFACES) as SurfaceId[]).flatMap((id) =>
  (SURFACES[id].chunks ?? []).map((module) => ({ id, module: `src/${module}` })),
);

/** The entry chunk and every chunk it imports statically, by file name. */
function entryClosure(): Set<string> {
  const entry = chunks.find((chunk) => chunk.isEntry);
  if (entry === undefined) throw new Error("the build made no entry chunk");
  const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of byFile.get(file)?.imports ?? []) walk(next);
  };
  walk(entry.fileName);
  return seen;
}

describe("the surfaces light closes load from their own chunks (criterion 9)", () => {
  it("reads its module list off the surface table, which names every one the card lists", () => {
    const ids = new Set(CHUNKED.map((c) => c.id));
    expect([...ids].sort()).toEqual([
      "fleets",
      "graph",
      "lab",
      "playbook",
      "spectrum",
      "stategraph",
      "text",
      "trace",
    ]);
    expect(CHUNKED.length).toBeGreaterThanOrEqual(14);
  });

  it("builds one entry chunk, and a manifest that names it", () => {
    const entries = chunks.filter((chunk) => chunk.isEntry);
    expect(entries).toHaveLength(1);
    const named = Object.values(manifest).filter((c) => c.isEntry === true);
    expect(named.map((c) => c.file)).toEqual([entries[0].fileName]);
  });

  for (const { id, module } of CHUNKED) {
    it(`${id}: ${module} is in a chunk of its own that the entry does not import statically`, () => {
      const path = `${WEB}${module}`;
      const home = chunks.find((chunk) => chunk.moduleIds.includes(path));
      expect(home, `${module} is in no chunk of this build`).toBeDefined();
      expect(
        home!.isEntry,
        `${module} is in the entry chunk: something the entry reaches imports it statically`,
      ).toBe(false);
      expect(entryClosure().has(home!.fileName), `${home!.fileName} is loaded with the entry`).toBe(false);
      // The manifest says the same: the chunk is one a dynamic import loads.
      const listed = Object.values(manifest).find((c) => c.file === home!.fileName);
      expect(listed?.isDynamicEntry, `${home!.fileName} in the manifest`).toBe(true);
    });
  }
});

describe("every chunked module has a loader, and App draws the lazy one", () => {
  it("names each table module in exactly one import() of surfaceChunks.ts", () => {
    const loaders = stripComments(read("./surfaceChunks.ts", import.meta.url));
    for (const { module } of CHUNKED) {
      const spec = `../${module.slice("src/".length).replace(/\.tsx?$/, "")}`;
      expect(loaders.split(`import("${spec}")`).length - 1, spec).toBe(1);
    }
  });

  it("imports none of the chunked modules statically in App", () => {
    const app = stripComments(read("../App.tsx", import.meta.url));
    for (const { module } of CHUNKED) {
      const spec = `./${module.slice("src/".length).replace(/\.tsx?$/, "")}`;
      expect(app, spec).not.toMatch(
        new RegExp(`import \\{[^}]*\\} from "${spec.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")}"`),
      );
    }
  });
});

// ---- the cascade -------------------------------------------------------------

/** One declaration of a style rule, with the at-rules around it. */
interface Declaration {
  /** The at-rule preludes around the rule, outermost first, joined by " | ". */
  context: string;
  /** One selector out of the rule's list, as the minifier wrote it. */
  selector: string;
  /** The property, lowercased. */
  property: string;
}

/** The index just past the string that starts at `at`. */
function pastString(css: string, at: number): number {
  const quote = css[at];
  let i = at + 1;
  while (i < css.length && css[i] !== quote) i += css[i] === "\\" ? 2 : 1;
  return i + 1;
}

/**
 * The index of the first of `stops` at bracket depth 0, outside strings and
 * comments, or the length of the sheet when there is none.
 */
function nextStop(css: string, from: number, stops: string): number {
  let depth = 0;
  let i = from;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i = pastString(css, i);
      continue;
    }
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && stops.includes(c)) return i;
    i++;
  }
  return i;
}

/** `text` cut at every `sep` that stands at bracket depth 0, outside strings. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = nextStop(text, from, sep);
    out.push(text.slice(from, at));
    if (at >= text.length) return out;
    from = at + 1;
  }
}

/** At-rules whose blocks hold no style rules: keyframe steps, font faces. */
const NOT_STYLE_RULES =
  /^@(-[a-z]+-)?(keyframes|font-face|property|page|counter-style|font-feature-values)\b/;

/**
 * Every declaration of every style rule in a built stylesheet, one entry per
 * selector and property. Throws on a nested style rule, which the minifier
 * lowers for this build's targets: a guard that cannot read a sheet says so.
 */
function declarationsOf(name: string, css: string): Declaration[] {
  const out: Declaration[] = [];
  const walk = (from: number, context: string[]): number => {
    let i = from;
    while (i < css.length) {
      const at = nextStop(css, i, "{};");
      if (at >= css.length) return at;
      const prelude = css.slice(i, at).trim();
      if (css[at] === "}") return at + 1;
      if (css[at] === ";") {
        i = at + 1;
        continue;
      }
      if (prelude.startsWith("@")) {
        i = walk(at + 1, [...context, prelude]);
        continue;
      }
      // Inside a keyframes block a "rule" is a step, not a selector.
      if (context.some((c) => NOT_STYLE_RULES.test(c))) {
        i = nextStop(css, at + 1, "}") + 1;
        continue;
      }
      const end = nextStop(css, at + 1, "{}");
      if (css[end] === "{")
        throw new Error(`${name}: a nested rule under ${prelude}; the guard cannot read it`);
      const body = css.slice(at + 1, end);
      for (const selector of splitTop(prelude, ",")) {
        for (const declaration of splitTop(body, ";")) {
          const colon = declaration.indexOf(":");
          if (colon <= 0) continue;
          out.push({
            context: context.join(" | "),
            selector: selector.trim(),
            property: declaration.slice(0, colon).trim().toLowerCase(),
          });
        }
      }
      i = end + 1;
    }
    return i;
  };
  walk(0, []);
  return out;
}

/** Longhands that start with a property's name but are not set by it. */
const NOT_SET_BY: Record<string, RegExp> = {
  stroke: /^stroke-/,
  fill: /^fill-/,
  border: /^border-(radius|(top|bottom)-(left|right)-radius|(start|end)-(start|end)-radius)$/,
  outline: /^outline-offset$/,
  flex: /^flex-(direction|wrap|flow)$/,
};

/**
 * Whether two properties set the same thing: the same name, or a shorthand and
 * one of its longhands (`background` and `background-color`). Custom
 * properties pair only by name.
 */
function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith("--") || b.startsWith("--")) return false;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (!long.startsWith(`${short}-`)) return false;
  return !(NOT_SET_BY[short]?.test(long) ?? false);
}

/** The stylesheets the entry chunk and its static imports load. */
function entryStylesheets(): Set<string> {
  const closure = entryClosure();
  return new Set(
    chunks
      .filter((chunk) => closure.has(chunk.fileName))
      .flatMap((chunk) => [...(chunk.viteMetadata?.importedCss ?? [])]),
  );
}

describe("the chunk split leaves the cascade where it was (review of criterion 9)", () => {
  it("builds an entry stylesheet the checks below compare against", () => {
    const entry = [...entryStylesheets()];
    expect(entry.length).toBeGreaterThan(0);
    for (const name of entry) expect(stylesheets.has(name), name).toBe(true);
    // The parser reads the entry sheet: the app's own rule for React Flow's
    // edges is in it, so an empty or misread parse cannot pass the next test.
    const declared = entry.flatMap((name) => declarationsOf(name, stylesheets.get(name)!));
    expect(declared.length).toBeGreaterThan(1000);
    expect(declared).toContainEqual({ context: "", selector: ".react-flow__edge-path", property: "stroke" });
  });

  it("gives no surface chunk, and no chunk one of them imports statically, a stylesheet of its own", () => {
    const closure = entryClosure();
    const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const moved: string[] = [];
    for (const { module } of CHUNKED) {
      const path = `${WEB}${module}`;
      const home = chunks.find((chunk) => chunk.moduleIds.includes(path));
      if (home === undefined) continue; // the tests above name a missing module
      const seen = new Set<string>();
      const walk = (file: string): void => {
        if (seen.has(file) || closure.has(file)) return;
        seen.add(file);
        const chunk = byFile.get(file);
        for (const css of chunk?.viteMetadata?.importedCss ?? [])
          moved.push(`${module} -> ${file} -> ${css}`);
        for (const next of chunk?.imports ?? []) walk(next);
      };
      walk(home.fileName);
    }
    expect(
      [...new Set(moved)],
      "a stylesheet a surface imports must be in the entry's, where main.tsx places it",
    ).toEqual([]);
  });

  it("lets no stylesheet outside the entry set a property the entry sets for the same selector", () => {
    const entry = entryStylesheets();
    const bySelector = new Map<string, string[]>();
    for (const name of entry) {
      for (const d of declarationsOf(name, stylesheets.get(name)!)) {
        const key = `${d.context}\u0000${d.selector}`;
        bySelector.set(key, [...(bySelector.get(key) ?? []), d.property]);
      }
    }
    const lazy = [...stylesheets.keys()].filter((name) => !entry.has(name));
    const clashes: string[] = [];
    for (const name of lazy) {
      for (const d of declarationsOf(name, stylesheets.get(name)!)) {
        const theirs = bySelector.get(`${d.context}\u0000${d.selector}`) ?? [];
        const hit = theirs.find((property) => overlaps(property, d.property));
        if (hit !== undefined) {
          clashes.push(
            `${name}: ${d.context ? `[${d.context}] ` : ""}${d.selector} { ${d.property} } against the entry's ${hit}`,
          );
        }
      }
    }
    expect([...new Set(clashes)]).toEqual([]);
  });
});
