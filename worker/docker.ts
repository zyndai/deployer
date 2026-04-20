// dockerode wrapper. Only exposes the calls the worker actually uses so
// we don't leak the whole Docker API surface.

import { readFile } from "node:fs/promises";
import Docker from "dockerode";

import { config } from "@/lib/config";

export const docker = new Docker({ socketPath: config.dockerSocket });

/**
 * Translate an in-process path to the path the Docker daemon will see.
 *
 * Prod (worker on host): returns the path unchanged — the worker and
 * the daemon share a filesystem.
 *
 * Dev (worker in a container): the data root is bind-mounted from the
 * host into the worker container, typically at different locations.
 * We swap the prefix so the daemon gets a host-resolvable path.
 */
function hostPath(p: string): string {
  if (!config.hostDataRoot) return p;
  if (!p.startsWith(config.dataRoot)) return p;
  return config.hostDataRoot + p.slice(config.dataRoot.length);
}

export interface RunOpts {
  deploymentId: string;
  workdir: string;             // host path to bind-mount at /app
  keyHostPath: string;         // host path to keypair.json (decrypted)
  entityType: "agent" | "service";
  hostPort: number;            // 127.0.0.1:<hostPort>:5000
  envFilePath: string;         // /var/lib/zynd-deployer/work/<id>/.env.rendered
}

/**
 * Create and start a container for a deployment. Returns the container
 * id. The caller is responsible for error cleanup (removing the container
 * + releasing the port) if downstream steps fail.
 */
export async function runContainer(opts: RunOpts): Promise<string> {
  const image =
    opts.entityType === "service"
      ? config.serviceBaseImage
      : config.agentBaseImage;

  // We rely on --env-file semantics via Env[] — dockerode takes an array
  // of "K=V" lines, so we read the rendered .env and pass it through.
  const envText = await readFile(opts.envFilePath, "utf8");
  const env: string[] = [];
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    env.push(trimmed);
  }

  const container = await docker.createContainer({
    name: `zynd-${opts.deploymentId}`,
    Image: image,
    Cmd:
      opts.entityType === "service"
        ? ["python", "/app/service.py"]
        : ["python", "/app/agent.py"],
    Env: env,
    ExposedPorts: { "5000/tcp": {} },
    HostConfig: {
      PortBindings: {
        "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(opts.hostPort) }],
      },
      Binds: [
        `${hostPath(opts.workdir)}:/app:ro`,
        `${hostPath(opts.keyHostPath)}:/app/keypair.json:ro`,
      ],
      RestartPolicy: { Name: "unless-stopped" },
      Memory: 512 * 1024 * 1024,
      NanoCpus: 500_000_000, // 0.5 CPU
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,exec,size=64m" },
      SecurityOpt: ["no-new-privileges"],
    },
    Labels: {
      "zynd.deployment": opts.deploymentId,
      "zynd.kind": opts.entityType,
    },
  });

  await container.start();
  return container.id;
}

export async function stopAndRemove(containerId: string): Promise<void> {
  const c = docker.getContainer(containerId);
  try {
    await c.stop({ t: 5 });
  } catch {
    // already stopped — fine
  }
  try {
    await c.remove({ force: true });
  } catch {
    // already gone — fine
  }
}

export async function inspectExitCode(containerId: string): Promise<number | null> {
  try {
    const info = await docker.getContainer(containerId).inspect();
    return info.State.ExitCode ?? null;
  } catch {
    return null;
  }
}

/**
 * Dockerode's non-TTY `logs()` returns the raw multiplexed stream format:
 * repeated frames of [stream_type(1), 0x00, 0x00, 0x00, size(4 BE), payload...].
 * The three 0x00 bytes in every frame header aren't legal in a Postgres
 * text column (error 22021), and the size bytes on their own tend to
 * produce garbled output even when they don't trip the encoding check.
 * Strip the headers and concatenate just the payloads.
 */
function demuxBuffer(buf: Buffer): string {
  let out = "";
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    i += 8;
    if (i + size > buf.length) break;
    out += buf.slice(i, i + size).toString("utf8");
    i += size;
  }
  return out;
}

/**
 * Read the last N lines from a container as a single UTF-8 string.
 * Used by the crash watcher to grab a tail when a container dies.
 */
export async function tailLogs(containerId: string, lines = 200): Promise<string> {
  try {
    const stream = await docker.getContainer(containerId).logs({
      stdout: true,
      stderr: true,
      tail: lines,
      timestamps: false,
    });
    // In non-follow mode dockerode resolves to a Buffer of the raw
    // multiplexed stream; demux it before returning text.
    const buf = Buffer.isBuffer(stream)
      ? (stream as Buffer)
      : Buffer.from(stream as unknown as string);
    return demuxBuffer(buf);
  } catch {
    return "";
  }
}
