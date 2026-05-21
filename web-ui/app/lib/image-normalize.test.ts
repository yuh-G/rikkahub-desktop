import { describe, expect, test } from "bun:test";

import { calculateImageSampleSize } from "./image-normalize";

describe("calculateImageSampleSize", () => {
  test("keeps long screenshots at original resolution when under pixel budget", () => {
    expect(calculateImageSampleSize(1272, 2800, 10_000, 16_000_000)).toBe(1);
  });

  test("downsamples very large images by pixel budget", () => {
    expect(calculateImageSampleSize(5000, 5000, 10_000, 16_000_000)).toBe(2);
  });

  test("downsamples extremely long images by max dimension", () => {
    expect(calculateImageSampleSize(1200, 20_000, 10_000, 16_000_000)).toBe(2);
  });
});
