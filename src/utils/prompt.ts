import * as readline from "node:readline";

export async function promptSecret(message: string): Promise<string> {
  // Check if stdin is a TTY for interactive input
  if (!process.stdin.isTTY) {
    // Non-interactive: read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  }

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr, // Use stderr so prompts don't pollute stdout
      terminal: true,
    });

    // Mute output for secret input
    process.stderr.write(message);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) {
      stdin.setRawMode(true);
    }

    let input = "";

    const onData = (char: Buffer) => {
      const str = char.toString("utf8");
      if (str === "\n" || str === "\r" || str === "\r\n") {
        if (stdin.setRawMode) {
          stdin.setRawMode(wasRaw ?? false);
        }
        stdin.removeListener("data", onData);
        process.stderr.write("\n");
        rl.close();
        resolve(input);
      } else if (str === "\u0003") {
        // Ctrl+C
        if (stdin.setRawMode) {
          stdin.setRawMode(wasRaw ?? false);
        }
        stdin.removeListener("data", onData);
        rl.close();
        reject(new Error("User cancelled"));
      } else if (str === "\u007f" || str === "\b") {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
        }
      } else {
        input += str;
      }
    };

    stdin.on("data", onData);
  });
}

export async function promptInput(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function promptConfirm(message: string): Promise<boolean> {
  const answer = await promptInput(`${message} (y/N): `);
  return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
}
