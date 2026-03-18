import type { AuthResult } from "../auth/types.ts";

export interface InjectedCurl {
  configLines: string[]; // Lines for curl --config stdin
  extraArgs: string[]; // Additional CLI args (e.g., --cert for mTLS)
  url: string; // Potentially modified URL (query params)
}

export function injectAuth(
  url: string,
  authResult: AuthResult,
  existingArgs: string[],
): InjectedCurl {
  const configLines: string[] = [];
  const extraArgs: string[] = [...(authResult.curlExtraArgs ?? [])];
  let finalUrl = url;

  // Inject headers via --config stdin (keeps secrets out of ps)
  if (authResult.headers) {
    for (const [name, value] of Object.entries(authResult.headers)) {
      // Skip internal headers
      if (name.startsWith("X-Clawth-")) continue;
      configLines.push(`header = "${name}: ${value}"`);
    }
  }

  // Inject query parameters into URL
  if (authResult.queryParams) {
    const parsedUrl = new URL(finalUrl);
    for (const [name, value] of Object.entries(authResult.queryParams)) {
      parsedUrl.searchParams.set(name, value);
    }
    finalUrl = parsedUrl.toString();
  }

  return { configLines, extraArgs, url: finalUrl };
}
