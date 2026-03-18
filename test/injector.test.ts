import { describe, test, expect } from "bun:test";
import { injectAuth } from "../src/curl/injector.ts";

describe("injectAuth", () => {
  test("injects headers as config lines", () => {
    const result = injectAuth("https://api.github.com/user", {
      headers: { Authorization: "Bearer secret-token" },
    }, []);

    expect(result.configLines).toContain('header = "Authorization: Bearer secret-token"');
    expect(result.url).toBe("https://api.github.com/user");
  });

  test("injects query parameters into URL", () => {
    const result = injectAuth("https://api.example.com/data", {
      queryParams: { api_key: "my-key-123" },
    }, []);

    expect(result.url).toContain("api_key=my-key-123");
  });

  test("passes through extra curl args", () => {
    const result = injectAuth("https://example.com", {
      curlExtraArgs: ["--cert", "/tmp/cert.p12", "--cert-type", "P12"],
    }, []);

    expect(result.extraArgs).toContain("--cert");
    expect(result.extraArgs).toContain("/tmp/cert.p12");
  });

  test("skips X-Clawth- internal headers", () => {
    const result = injectAuth("https://example.com", {
      headers: {
        Authorization: "Bearer token",
        "X-Clawth-Temp-Cert": "/tmp/cert.p12",
      },
    }, []);

    expect(result.configLines.length).toBe(1);
    expect(result.configLines[0]).toContain("Authorization");
  });
});
