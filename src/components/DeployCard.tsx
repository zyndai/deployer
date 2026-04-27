"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import JSZip from "jszip";

import { DropZone } from "./DropZone";
import type { Runtime } from "@/lib/types";

type EntityType = "agent" | "service";

export function DeployCard({
  entityType,
  runtime,
}: {
  entityType: EntityType;
  runtime: Runtime;
}) {
  const router = useRouter();
  const [projectFiles, setProjectFiles] = useState<Map<string, File> | null>(null);
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The canonical entry filename displayed in hints depends on both
  // the entity type and the chosen runtime.
  const entryFilename =
    runtime === "node" ? `${entityType}.ts` : `${entityType}.py`;
  const manifestFilename =
    runtime === "node" ? "package.json" : "requirements.txt";

  const projectSummary = useMemo(() => {
    if (!projectFiles) return undefined;
    const count = projectFiles.size;
    const configFile =
      entityType === "agent" ? "agent.config.json" : "service.config.json";
    const hasConfig = Array.from(projectFiles.keys()).some((p) =>
      p.endsWith(configFile)
    );
    return `${count} file${count === 1 ? "" : "s"}${hasConfig ? "" : ` · missing ${configFile}`}`;
  }, [projectFiles, entityType]);

  const keySummary = keyFile ? keyFile.name : undefined;

  const canSubmit = projectFiles && keyFile && !submitting;

  const onDeploy = async () => {
    if (!projectFiles || !keyFile) return;
    setErr(null);
    setSubmitting(true);
    try {
      // Re-zip in the browser. We build a clean zip that always has the
      // project at the root so the server doesn't have to worry about
      // wrapper folders. We do preserve subdirectories from the drop.
      const zip = new JSZip();

      // Figure out whether there's a single top-level wrapper folder.
      const filePaths = Array.from(projectFiles.keys());
      const tops = new Set(filePaths.map((p) => p.split("/")[0]));
      const strip =
        tops.size === 1 && filePaths.every((p) => p.includes("/"))
          ? `${Array.from(tops)[0]}/`
          : "";

      for (const [rel, f] of projectFiles) {
        const target = strip && rel.startsWith(strip) ? rel.slice(strip.length) : rel;
        if (!target) continue;
        zip.file(target, await f.arrayBuffer());
      }

      const zipBlob = await zip.generateAsync({ type: "blob" });

      const form = new FormData();
      form.set("project.zip", zipBlob, "project.zip");
      form.set("keypair.json", keyFile, "keypair.json");
      // Pass the client-side toggle as a hint. The server re-validates and
      // uses the detected runtime from the upload contents as source of truth.
      form.set("runtime", runtime);

      const res = await fetch("/api/deployments", {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      router.push(`/d/${data.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const title = entityType === "agent" ? "Deploy Agent" : "Deploy Service";

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1 text-xs text-white/50">
        Drop your Zynd {entityType} project folder (contains{" "}
        <code className="text-white/70">{entityType}.config.json</code> and{" "}
        <code className="text-white/70">{entryFilename}</code>
        {manifestFilename === "package.json" ? (
          <>
            {" "}and <code className="text-white/70">package.json</code>
          </>
        ) : null}
        ) and its <code className="text-white/70">keypair.json</code>.
        {runtime === "node" && (
          <span className="ml-1 text-white/40">
            Do not include <code>node_modules/</code>.
          </span>
        )}
      </p>

      <div className="mt-5 space-y-4">
        <DropZone
          label="Project folder"
          hint="Drag the whole folder here, or click to pick it"
          folder
          onFiles={(f) => setProjectFiles(f as Map<string, File>)}
          selectedSummary={projectSummary}
        />
        <DropZone
          label="keypair.json"
          hint="The Ed25519 identity file for this entity"
          accept="application/json,.json"
          onFiles={(files) => {
            const arr = files as File[];
            if (arr.length > 0) setKeyFile(arr[0]);
          }}
          selectedSummary={keySummary}
        />
      </div>

      {err && (
        <div className="mt-4 rounded border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
          {err}
        </div>
      )}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={onDeploy}
        className="mt-5 w-full rounded-md bg-zynd-purple px-4 py-2 text-sm font-medium text-white transition hover:bg-zynd-purple/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submitting ? "Uploading…" : `Deploy ${entityType}`}
      </button>
    </div>
  );
}
