// Thin wrapper around the `age` binary for encrypting uploaded blobs and
// keypairs at rest. We shell out rather than binding a JS age library so
// the format stays interoperable with the stock `age` CLI that operators
// already know.
//
// Requires `age` and `age-keygen` on PATH. See infra/install.sh.

import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { config } from "./config";

interface AgeResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

async function runAge(args: string[], stdin: Buffer | string): Promise<AgeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("age", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let stderr = "";

    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        stdout: Buffer.concat(chunks),
        stderr,
        code: code ?? 1,
      })
    );

    child.stdin.end(stdin);
  });
}

// Read the master age identity (private) and derive the recipient line
// (public) so we don't have to keep both on disk.
async function readIdentity(): Promise<{ identity: string; recipient: string }> {
  const raw = await readFile(config.ageIdentityPath, "utf8");
  const identityLine = raw
    .split(/\r?\n/)
    .find((l) => l.startsWith("AGE-SECRET-KEY-"));
  const recipientLine = raw
    .split(/\r?\n/)
    .find((l) => l.startsWith("# public key:"))
    ?.replace("# public key:", "")
    .trim();

  if (!identityLine || !recipientLine) {
    throw new Error(
      `Age identity at ${config.ageIdentityPath} is malformed; regenerate with \`age-keygen -o <path>\``
    );
  }
  return { identity: identityLine, recipient: recipientLine };
}

export async function encryptToFile(data: Buffer, outPath: string): Promise<void> {
  const { recipient } = await readIdentity();
  await mkdir(dirname(outPath), { recursive: true });

  const { stdout, stderr, code } = await runAge(
    ["--encrypt", "--recipient", recipient, "--output", outPath],
    data
  );
  if (code !== 0) {
    throw new Error(`age encrypt failed (${code}): ${stderr}`);
  }
  // --output already wrote the file; stdout is empty. Keep the signature
  // symmetric with decryptFile which does use stdout.
  void stdout;
}

export async function decryptFile(inPath: string): Promise<Buffer> {
  // Pass the identity as a file so age can read it — avoids leaking the
  // secret through argv.
  const encrypted = await readFile(inPath);
  const { stdout, stderr, code } = await runAge(
    ["--decrypt", "--identity", config.ageIdentityPath],
    encrypted
  );
  if (code !== 0) {
    throw new Error(`age decrypt failed (${code}): ${stderr}`);
  }
  return stdout;
}

// Convenience for the worker: decrypt directly to a target path.
export async function decryptToFile(inPath: string, outPath: string): Promise<void> {
  const buf = await decryptFile(inPath);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buf, { mode: 0o600 });
}
