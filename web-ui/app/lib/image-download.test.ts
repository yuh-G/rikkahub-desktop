import { describe, expect, test } from "bun:test";

import { fileExtensionFromMime } from "./image-download";

describe("fileExtensionFromMime", () => {
  test("keeps common preview export formats", () => {
    expect(fileExtensionFromMime("image/png")).toBe("png");
    expect(fileExtensionFromMime("image/webp")).toBe("webp");
    expect(fileExtensionFromMime("image/gif")).toBe("gif");
  });

  test("normalizes jpeg and svg variants", () => {
    expect(fileExtensionFromMime("image/jpeg")).toBe("jpg");
    expect(fileExtensionFromMime("IMAGE/JPG")).toBe("jpg");
    expect(fileExtensionFromMime("image/svg+xml")).toBe("svg");
  });

  test("falls back to png when the server omits an image mime", () => {
    expect(fileExtensionFromMime("application/octet-stream")).toBe("png");
    expect(fileExtensionFromMime("")).toBe("png");
  });
});
