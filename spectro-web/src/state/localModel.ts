// The built-in model's download: the API calls behind the picker's download
// modal, plus the pure formatters its progress bar renders. See the server's
// LocalModelController (GET /api/local-model/status, POST .../download).

/** The pinned Q4_K_M size, for the "~1.9 GB" the modal shows before any status. */
export const LOCAL_MODEL_SIZE = 1_929_903_232;

/** The built-in model's display name — matches the picker entry. */
export const LOCAL_MODEL_NAME = "VibeThinker-3B";

export interface LocalModelStatus {
  /** absent | downloading | ready | failed */
  state: string;
  bytes: number;
  total: number;
  error?: string;
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

/** Poll the current download/presence state. */
export async function fetchLocalModelStatus(): Promise<LocalModelStatus> {
  const res = await fetch("/api/local-model/status");
  return (await res.json()) as LocalModelStatus;
}

/** Start the download (idempotent server-side); returns the fresh status. */
export async function startLocalModelDownload(): Promise<LocalModelStatus> {
  const res = await fetch("/api/local-model/download", { method: "POST" });
  return (await res.json()) as LocalModelStatus;
}
