import { describe, test, expect } from "bun:test";
import { parseCurlArgs } from "../src/curl/parser.ts";

describe("parseCurlArgs", () => {
  test("parses simple URL", () => {
    const result = parseCurlArgs(["https://api.github.com/user"]);
    expect(result.url).toBe("https://api.github.com/user");
    expect(result.method).toBe("GET");
  });

  test("parses method flag", () => {
    const result = parseCurlArgs(["-X", "POST", "https://example.com/api"]);
    expect(result.method).toBe("POST");
  });

  test("parses headers", () => {
    const result = parseCurlArgs([
      "-H",
      "Content-Type: application/json",
      "https://example.com",
    ]);
    expect(result.headers["Content-Type"]).toBe("application/json");
  });

  test("parses body and infers POST", () => {
    const result = parseCurlArgs([
      "-d",
      '{"key":"value"}',
      "https://example.com",
    ]);
    expect(result.method).toBe("POST");
    expect(result.body).toBe('{"key":"value"}');
  });

  test("adds https:// to bare hostname", () => {
    const result = parseCurlArgs(["api.github.com"]);
    expect(result.url).toBe("https://api.github.com");
  });

  test("preserves remaining args", () => {
    const result = parseCurlArgs([
      "-v",
      "--silent",
      "https://example.com",
    ]);
    expect(result.remainingArgs).toContain("-v");
    expect(result.remainingArgs).toContain("--silent");
  });
});
