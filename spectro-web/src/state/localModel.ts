// The built-in provider's model catalogue: the API calls behind the picker's
// chooser dialog, plus the pure formatters and verdict folds its rows render.
// See the server's LocalModelController (GET /api/local-model/catalog,
// GET .../status?model=, POST .../download?model=).

export interface LocalModelStatus {
  /** absent | downloading | ready | failed */
  state: string;
  bytes: number;
  total: number;
  error?: string;
}

/** One catalogue row as the server reports it: the model's facts, its download
 *  state and whether this machine can hold it. */
export interface CatalogModel {
  id: string;
  label: string;
  sizeBytes: number;
  minRamBytes: number;
  contextTokens: number;
  nativeTools: boolean;
  reasoning: boolean;
  licence: string;
  licenceUrl: string;
  sourceUrl: string;
  licenceCaveat?: boolean;
  state: string;
  bytes: number;
  preflight: { ok: boolean; tight: boolean; known: boolean; ramOk: boolean; diskOk: boolean };
}

export interface Catalog {
  defaultId: string;
  machine: { ramTotalBytes: number; diskFreeBytes: number; binaryPresent?: boolean };
  models: CatalogModel[];
}

/** Download progress as a whole percent, clamped to 0..100. */
export function progressPct(bytes: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((bytes / total) * 100)));
}

/** Bytes as a one-decimal GB string (decimal GB, matching disk/marketing sizes). */
export function formatGB(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** The i18n key of the machine-fit line for one row — the ampel the chooser
 *  shows under each model. Order matters: an unknown machine says so before
 *  anything else (we never invent a refusal), then disk, then memory. */
export function fitKey(m: CatalogModel): string {
  if (!m.preflight.known) return "lm.fit.unknown";
  if (!m.preflight.diskOk) return "lm.fit.disk";
  if (!m.preflight.ramOk) return "lm.fit.ram";
  if (m.preflight.tight) return "lm.fit.tight";
  return "lm.fit.ok";
}

/** The picker/header label for the built-in provider under a given model —
 *  'built-in · Qwen3 4B' when the catalogue knows the id, 'built-in' alone
 *  otherwise (never a wrong hardcoded name). */
export function builtInLabel(model: string | undefined, labels: Record<string, string>): string {
  const label = model ? labels[model] : undefined;
  return label ? `built-in · ${label}` : "built-in";
}

/** Fetch the whole catalogue — the chooser's one initial request. A non-200 is
 *  thrown rather than parsed: the write fence answers 404 with no JSON body, and
 *  parsing that would take the whole App render down with it. */
export async function fetchLocalCatalog(): Promise<Catalog> {
  const res = await fetch("/api/local-model/catalog");
  if (!res.ok) throw new Error(`local-model catalog ${res.status}`);
  const catalog = (await res.json()) as Catalog;
  if (!Array.isArray(catalog?.models)) throw new Error("local-model catalog: unexpected shape");
  return catalog;
}

/** Poll one model's download/presence state. */
export async function fetchLocalModelStatus(model: string): Promise<LocalModelStatus> {
  const res = await fetch(`/api/local-model/status?model=${encodeURIComponent(model)}`);
  if (!res.ok) throw new Error(`local-model status ${res.status}`);
  return (await res.json()) as LocalModelStatus;
}

/** Start one model's download (idempotent server-side); returns the fresh status. */
export async function startLocalModelDownload(model: string): Promise<LocalModelStatus> {
  const res = await fetch(`/api/local-model/download?model=${encodeURIComponent(model)}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`local-model download ${res.status}`);
  return (await res.json()) as LocalModelStatus;
}
