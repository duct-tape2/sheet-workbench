import { it, expect, afterEach, vi } from "vitest";
import { trustedOriginsFor } from "../apps/server/src/auth";
afterEach(() => vi.unstubAllEnvs());
it("uses a configured canonical origin and rejects wildcard or path origins", () => {
  vi.stubEnv("TRUSTED_ORIGINS", "");
  vi.stubEnv("BETTER_AUTH_URL", "https://work.example.test");
  expect(trustedOriginsFor()).toEqual(["https://work.example.test"]);
  expect(() =>
    trustedOriginsFor({ trustedOrigins: ["https://*.example.test"] }),
  ).toThrow();
  expect(() =>
    trustedOriginsFor({ trustedOrigins: ["https://work.example.test/path"] }),
  ).toThrow();
});
it("allows explicit local development origins and requires HTTPS for public production", () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(
    trustedOriginsFor({
      trustedOrigins: ["http://localhost:3001", "https://work.example.test"],
    }),
  ).toHaveLength(2);
  expect(() =>
    trustedOriginsFor({ trustedOrigins: ["http://work.example.test"] }),
  ).toThrow("HTTPS");
});
