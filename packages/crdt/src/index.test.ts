import { describe, it, expect } from "vitest";
import { PACKAGE_NAME } from "./index";

describe("setup", () => {
  it("runs a test", () => {
    expect(PACKAGE_NAME).toBe("@collab/crdt");
  });
});
