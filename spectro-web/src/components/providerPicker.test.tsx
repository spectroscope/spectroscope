// Card 480, task 8 (D9): the chat picker lists every provider and greys out
// the ones that will fail on the first call. Driven through the component
// itself, without a DOM (testkit/driveComponent), so what is pinned is the
// element tree a user gets: which options are disabled, what the tooltip says
// and whether Switch can be pressed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dict } from "../i18n/i18n";
import { __resetProviderRegistry, __seedProviderRows, type ProviderRow } from "../state/providerRegistry";
import { drive, type El, type Step } from "../testkit/driveComponent";
import { read, stripComments } from "../testkit/source";
import { ProviderPicker } from "./ProviderPicker";
import { PROVIDERS } from "./providerPickerMode";

beforeEach(() => {
  __resetProviderRegistry();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const row = (over: Partial<ProviderRow> & Pick<ProviderRow, "id">): ProviderRow => ({
  kind: "local",
  state: "configured",
  keyPresent: false,
  endpoint: null,
  models: [],
  live: false,
  reason: null,
  checkedAt: 1,
  ...over,
});

const ollamaDown = row({
  id: "ollama",
  state: "failed",
  endpoint: "http://localhost:11434",
  reason: "refused",
});
const openrouterKeyless = row({ id: "openrouter", kind: "cloud", state: "needs-key" });
const anthropicOk = row({ id: "anthropic", kind: "cloud", state: "configured", keyPresent: true });

const openChip: Step = (tree) => tree.find((el) => el.props["aria-haspopup"] === "dialog")?.props.onClick?.();
const choose =
  (provider: string): Step =>
  (tree) =>
    tree.find((el) => el.type === "select")?.props.onChange?.({ target: { value: provider } });

function picker(current: string, steps: Step[]): El[] {
  return drive(
    <ProviderPicker provider={current} status="open" onApply={() => {}} />,
    [ProviderPicker],
    [openChip, ...steps],
  );
}

const optionOf = (tree: El[], id: string): El => {
  const found = tree.find((el) => el.type === "option" && el.props.value === id);
  if (!found) throw new Error(`no <option> for ${id}`);
  return found;
};
const switchButton = (tree: El[]): El => {
  const found = tree.find((el) => el.type === "button" && el.props.className === "soft-primary");
  if (!found) throw new Error("no Switch button");
  return found;
};

describe("the picker's option list", () => {
  it("lists all eight providers, hiding none, even when the registry knows nothing", () => {
    const tree = picker("anthropic", []);
    const listed = tree.filter((el) => el.type === "option").map((el) => el.props.value);
    expect(listed).toEqual([...PROVIDERS]);
    expect(PROVIDERS).toHaveLength(8);
    expect(tree.filter((el) => el.type === "option").every((el) => el.props.disabled === false)).toBe(true);
  });

  it("renders a failed provider disabled, with the address and the reason as its title", () => {
    __seedProviderRows([ollamaDown, anthropicOk]);
    const option = optionOf(picker("anthropic", []), "ollama");
    expect(option.props.disabled).toBe(true);
    expect(option.props.title).toBe("not answering at http://localhost:11434 (refused)");
  });

  it("renders a provider without a key disabled, with the no-key reason", () => {
    __seedProviderRows([openrouterKeyless]);
    const option = optionOf(picker("anthropic", []), "openrouter");
    expect(option.props.disabled).toBe(true);
    expect(option.props.title).toBe(dict["pp.optNeedsKey"].en);
  });

  it("positive twin: a configured provider is enabled and carries no title", () => {
    __seedProviderRows([ollamaDown, anthropicOk]);
    const option = optionOf(picker("ollama", []), "anthropic");
    expect(option.props.disabled).toBe(false);
    expect(option.props.title).toBeUndefined();
  });

  it("keeps the chat's own provider selectable although it is failed", () => {
    __seedProviderRows([ollamaDown]);
    const tree = picker("ollama", []);
    expect(optionOf(tree, "ollama").props.disabled).toBe(false);
    expect(switchButton(tree).props.disabled).toBe(false);
  });
});

describe("Switch", () => {
  it("is disabled while a disabled provider is selected, and the reason is written under the select", () => {
    __seedProviderRows([ollamaDown, anthropicOk]);
    const tree = picker("anthropic", [choose("ollama")]);
    expect(switchButton(tree).props.disabled).toBe(true);
    const note = tree.find((el) => el.props.className === "provider-field-note");
    expect(note?.props.children).toBe("not answering at http://localhost:11434 (refused)");
  });

  it("is enabled for an enabled provider, with no note", () => {
    __seedProviderRows([ollamaDown, anthropicOk]);
    const tree = picker("ollama", [choose("anthropic")]);
    expect(switchButton(tree).props.disabled).toBe(false);
    expect(tree.some((el) => el.props.className === "provider-field-note")).toBe(false);
  });
});

describe("opening the picker", () => {
  it("refreshes the rows and then checks the local kind only (D10: no cloud call on open)", () => {
    // Effects do not run on the server renderer, so this one is pinned on the source.
    const source = stripComments(read("./ProviderPicker.tsx", import.meta.url));
    expect(source).toContain('refreshProviders().then(() => checkProviders("local"))');
    expect(source).not.toContain('checkProviders("all")');
  });
});
