import { describe, expect, it } from "vitest";
import { getHealth } from "./client";

describe("getHealth", () => {
  it("returns the admin service identity", async () => {
    await expect(getHealth()).resolves.toEqual({ service: "yijie-admin-web", status: "ok" });
  });
});
