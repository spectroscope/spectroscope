// Card 443: the generated images are a panel of the dock, not an area of
// their own beside it.
//
// Criterion 1 compares the panel against what the old area showed. The old
// area is gone after this card, so its output for one fixture was recorded on
// main (2420933c) before anything moved: the `imagegen` scenario, folded,
// rendered by the old ImagePanel. The recording is kept in the card's evidence
// folder; the list below is that recording, not a list typed from memory.

import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RightPanel } from "../components/RightPanel";
import { DOCK_ORDER, dockLabelKey, panelFills } from "./dockModel";
import { SCENARIOS } from "../scenario/registry";
import { compile } from "../scenario/compile";
import { initialState, reduce } from "../state/reducer";
import type { GeneratedImage } from "../state/reducer";
import { __getState, __resetForTests, openDockPanel, toggleRightPanel } from "../state/layout";
import { imagesShown, revealImagesPanel, toggleImagesPanel } from "../state/imagesPanel";
import { dict } from "../i18n/i18n";

beforeEach(() => __resetForTests());

/** What the old area rendered for the `imagegen` scenario on main: newest
 *  first, each card a link to the full-size file, the prompt as caption. */
const RECORDED_ON_MAIN = [
  {
    href: "/demo/beach-cat.jpg",
    src: "/demo/beach-cat.jpg",
    caption:
      "A cute fluffy cat relaxing on a beach lounge chair, aviator sunglasses, tropical cocktail with a paper umbrella, palm trees and turquoise ocean, sunny, photorealistic, high detail",
  },
  {
    href: "/api/images/imagegen-c1.png",
    src: "/api/images/imagegen-c1.png",
    caption: "a cat on a beach with sunglasses, holding a cocktail",
  },
];

function fixtureImages(): GeneratedImage[] {
  const dsl = SCENARIOS.find((s) => s.id === "imagegen");
  if (dsl === undefined) throw new Error("the imagegen scenario is the fixture");
  return compile(dsl, "en").reduce(reduce, initialState).images;
}

function renderDock(images: GeneratedImage[]): string {
  return renderToStaticMarkup(
    <RightPanel
      agents={[]}
      plan={null}
      onClose={() => {}}
      thinking
      workspace={null}
      sessionId={null}
      images={images}
      imageProvider="gemini"
      imageKeys={null}
      onImageProviderChange={() => {}}
    />,
  );
}

/** The image cards inside the dock's images section, in DOM order. */
function cardsIn(html: string): { href: string; src: string; caption: string }[] {
  const section = html.match(/<section[^>]*data-panel="images"[\s\S]*?<\/section>/)?.[0] ?? "";
  return [
    ...section.matchAll(
      /<a class="image-card" href="([^"]*)"[^>]*><img[^>]*src="([^"]*)"[^>]*\/><span class="image-caption">([^<]*)<\/span>/g,
    ),
  ].map((m) => ({ href: m[1], src: m[2], caption: m[3] }));
}

describe("the images are a dock panel (card 443, criterion 1)", () => {
  it("the dock model names the images panel, with a label in both languages", () => {
    expect(DOCK_ORDER).toContain("images");
    const entry = dict[dockLabelKey("images")];
    expect(entry).toBeDefined();
    expect(entry.en).toBe("Images");
    expect(entry.de).toBe("Bilder");
    // A list of pictures scrolls inside its card like prose.
    expect(panelFills("images")).toBe(false);
  });

  it("the fixture holds the two pictures the recording was made from", () => {
    expect(fixtureImages()).toHaveLength(2);
  });

  it("shows the same pictures in the same order as the old area did", () => {
    openDockPanel("images");
    expect(cardsIn(renderDock(fixtureImages()))).toEqual(RECORDED_ON_MAIN);
  });

  it("a click opens the picture the way the old area did: full size, new tab", () => {
    openDockPanel("images");
    const html = renderDock(fixtureImages());
    const section = html.match(/<section[^>]*data-panel="images"[\s\S]*?<\/section>/)?.[0] ?? "";
    const links = section.match(/<a class="image-card"[^>]*>/g) ?? [];
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
  });

  it("the dock's tab strip offers the images, with the count", () => {
    const html = renderDock(fixtureImages());
    const strip = html.match(/<div class="dock-strip"[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(strip).toMatch(/>Images<span class="tab-count tabular">2<\/span>/);
    // Closed until asked for: the panel itself is not in the dock yet.
    expect(html).not.toContain('data-panel="images"');
    expect(html).toContain('data-panel="agents"');
  });

  it("an empty session shows the empty note inside the panel", () => {
    openDockPanel("images");
    const html = renderDock([]);
    expect(html).toContain('data-panel="images"');
    expect(cardsIn(html)).toEqual([]);
    expect(html).toContain(dict["img.empty"].en);
  });
});

describe("the header toggle and the View menu open the dock panel (criteria 1 and 4)", () => {
  it("from a hidden dock: shows the dock with the images panel open", () => {
    expect(__getState().rightPanelOpen).toBe(false);
    expect(imagesShown(__getState())).toBe(false);
    toggleImagesPanel();
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockImages).toBe("open");
    expect(imagesShown(__getState())).toBe(true);
    // An explicit ask: the dock returns in the next session (card 242).
    expect(__getState().dockReturn).toBe(true);
  });

  it("with the images shown: closes the images panel and leaves the dock", () => {
    toggleImagesPanel();
    toggleImagesPanel();
    expect(__getState().dockImages).toBe("closed");
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockAgents).toBe("open");
  });

  it("with the panel open behind a hidden dock: shows it instead of closing it unseen", () => {
    openDockPanel("images");
    expect(__getState().rightPanelOpen).toBe(false);
    toggleImagesPanel();
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockImages).toBe("open");
  });

  it("a new picture reveals the panel without writing the return memory", () => {
    revealImagesPanel();
    expect(__getState().rightPanelOpen).toBe(true);
    expect(__getState().dockImages).toBe("open");
    expect(__getState().dockReturn).toBe(false);
  });

  it("the dock's own close still hides the images with the dock", () => {
    toggleImagesPanel();
    toggleRightPanel();
    expect(imagesShown(__getState())).toBe(false);
    expect(__getState().dockImages).toBe("open");
  });
});
