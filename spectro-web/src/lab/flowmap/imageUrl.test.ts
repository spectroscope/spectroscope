import { describe, expect, it } from "vitest";
import { imageUrl, isDemoImage } from "./imageUrl";

describe("imageUrl — blobPath to browser URL", () => {
  it("serves a store blob via the image endpoint, by file name", () => {
    expect(imageUrl("/Users/x/.spectro/images/abc123.png")).toBe("/api/images/abc123.png");
    expect(imageUrl(".spectro/images/img-0001.png")).toBe("/api/images/img-0001.png");
  });
  it("serves a bundled demo asset as-is", () => {
    expect(isDemoImage("/demo/beach-cat.jpg")).toBe(true);
    expect(imageUrl("/demo/beach-cat.jpg")).toBe("/demo/beach-cat.jpg");
  });
});
