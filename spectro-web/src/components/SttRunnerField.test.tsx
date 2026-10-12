// Card 528 fix round 1, finding 4: the sttRunner select on the speech-to-text
// pane. The pane fetches its status before it draws anything, and this suite
// has no DOM, so the field is a component of its own: its markup is rendered
// to a string, and its change handler is called from the returned tree.

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { dict } from "../i18n/i18n";
import { SttRunnerField } from "./SttSettings";

/** Every element of a returned tree for which the test says yes. */
function find(
  node: ReactNode,
  yes: (el: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    if (yes(el)) out.push(el);
    walk(el.props.children as ReactNode);
  };
  walk(node);
  return out;
}

const RUNNERS = ["auto", "cli", "server"];

describe("SttRunnerField", () => {
  it("offers the three runners in order, with the configured one selected", () => {
    const html = renderToStaticMarkup(
      <SttRunnerField
        runner="server"
        localRunner={undefined}
        lang="en"
        onSave={() => {}}
        onSaved={() => {}}
      />,
    );

    const values = [...html.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    expect(values).toEqual(RUNNERS);
    expect(html).toMatch(/<option[^>]*value="server"[^>]*selected/);
    expect(html).toContain(dict["set.sttRunner"].en);
    for (const r of RUNNERS) {
      expect(html).toContain(dict[`set.sttRunner.${r}` as keyof typeof dict].en);
    }
  });

  it("names the runners in German too", () => {
    const html = renderToStaticMarkup(
      <SttRunnerField runner="auto" localRunner={undefined} lang="de" onSave={() => {}} onSaved={() => {}} />,
    );

    expect(html).toContain(dict["set.sttRunner"].de);
    for (const r of RUNNERS) {
      expect(html).toContain(dict[`set.sttRunner.${r}` as keyof typeof dict].de);
    }
  });

  it("saves sttRunner with the value picked and then re-reads the status", () => {
    const saved: Record<string, unknown>[] = [];
    let reread = 0;
    const tree = SttRunnerField({
      runner: "auto",
      localRunner: undefined,
      lang: "en",
      onSave: (patch) => saved.push(patch),
      onSaved: () => reread++,
    });

    const select = find(tree, (el) => el.type === "select")[0];
    (select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "cli" } });

    expect(saved).toEqual([{ sttRunner: "cli" }]);
    expect(reread).toBe(1);
    expect(select.props.disabled).toBe(false);
  });

  it("is greyed out without a way to save", () => {
    const tree = SttRunnerField({ runner: "auto", localRunner: undefined, lang: "en", onSaved: () => {} });

    expect(find(tree, (el) => el.type === "select")[0].props.disabled).toBe(true);
  });

  it("draws nothing against a server that does not report the runner", () => {
    expect(
      SttRunnerField({
        runner: undefined,
        localRunner: undefined,
        lang: "en",
        onSave: () => {},
        onSaved: () => {},
      }),
    ).toBeNull();
  });

  it("carries the state of the resident server under the select", () => {
    const html = renderToStaticMarkup(
      <SttRunnerField
        runner="server"
        localRunner={{ configured: "server", running: "server", up: true, port: 51234, fallback: false }}
        lang="en"
        onSave={() => {}}
        onSaved={() => {}}
      />,
    );

    expect(html).toContain("51234");
  });
});
