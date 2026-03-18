import { describe, test, expect } from "bun:test";
import { signAwsSigV4 } from "../src/crypto/aws-sigv4.ts";

describe("AWS SigV4", () => {
  test("generates valid authorization header", () => {
    const result = signAwsSigV4({
      method: "GET",
      url: "https://s3.amazonaws.com/my-bucket/my-key",
      headers: {},
      body: "",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "s3",
    });

    expect(result.headers["Authorization"]).toContain("AWS4-HMAC-SHA256");
    expect(result.headers["Authorization"]).toContain("Credential=AKIAIOSFODNN7EXAMPLE");
    expect(result.headers["Authorization"]).toContain("us-east-1/s3/aws4_request");
    expect(result.headers["X-Amz-Date"]).toBeTruthy();
    expect(result.headers["X-Amz-Content-Sha256"]).toBeTruthy();
  });

  test("includes security token header when session token provided", () => {
    const result = signAwsSigV4({
      method: "GET",
      url: "https://s3.amazonaws.com/test",
      headers: {},
      body: "",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secretkey",
      sessionToken: "session-token-123",
      region: "us-west-2",
      service: "s3",
    });

    expect(result.headers["X-Amz-Security-Token"]).toBe("session-token-123");
  });
});
