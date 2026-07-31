// One rule for turning an image_generated blobPath into a browser URL:
// real store blobs are fetched from the server's image endpoint by file name;
// bundled DEMO assets (scripted scenarios — /demo/…) are app-served as-is.

/** True for a bundled demo asset (a scripted scenario's image). */
export function isDemoImage(blobPath: string): boolean {
  return blobPath.startsWith("/demo/");
}

/** The browser URL for a generated image's blobPath. */
export function imageUrl(blobPath: string): string {
  if (isDemoImage(blobPath)) return blobPath;
  const file = blobPath.slice(blobPath.lastIndexOf("/") + 1);
  return `/api/images/${encodeURIComponent(file)}`;
}
