import { describe, expect, test } from "vitest";

import { MESH_RECOMMENDED_MAX, exceedsMeshRecommendation } from "../src/mesh.js";

describe("exceedsMeshRecommendation", () => {
  test("is false below the ceiling", () => {
    expect(exceedsMeshRecommendation(0)).toBe(false);
    expect(exceedsMeshRecommendation(MESH_RECOMMENDED_MAX - 1)).toBe(false);
  });

  test("is true at and above the ceiling", () => {
    expect(exceedsMeshRecommendation(MESH_RECOMMENDED_MAX)).toBe(true);
    expect(exceedsMeshRecommendation(MESH_RECOMMENDED_MAX + 1)).toBe(true);
  });
});
