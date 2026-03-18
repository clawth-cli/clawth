export interface ParsedCurlArgs {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  remainingArgs: string[];
}

export function parseCurlArgs(args: string[]): ParsedCurlArgs {
  let url = "";
  let method = "GET";
  const headers: Record<string, string> = {};
  let body: string | undefined;
  const remainingArgs: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === "-X" || arg === "--request") {
      method = args[++i]!;
    } else if (arg === "-H" || arg === "--header") {
      const headerStr = args[++i]!;
      const colonIdx = headerStr.indexOf(":");
      if (colonIdx > 0) {
        const name = headerStr.slice(0, colonIdx).trim();
        const value = headerStr.slice(colonIdx + 1).trim();
        headers[name] = value;
      }
    } else if (arg === "-d" || arg === "--data" || arg === "--data-raw") {
      body = args[++i]!;
      if (method === "GET") method = "POST";
    } else if (arg === "--data-binary") {
      body = args[++i]!;
      if (method === "GET") method = "POST";
    } else if (
      !arg.startsWith("-") &&
      !url &&
      (arg.startsWith("http://") || arg.startsWith("https://"))
    ) {
      url = arg;
    } else if (arg === "--url") {
      url = args[++i]!;
    } else {
      remainingArgs.push(arg);
    }
    i++;
  }

  if (!url) {
    // Try the first non-flag argument as URL
    const urlIdx = args.findIndex(
      (a) => !a.startsWith("-") && (a.includes(".") || a.includes("localhost")),
    );
    if (urlIdx >= 0) {
      url = args[urlIdx]!;
      // Add https:// if missing
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        url = `https://${url}`;
      }
    }
  }

  if (!url) {
    throw new Error("No URL found in curl arguments");
  }

  return { url, method, headers, body, remainingArgs };
}
