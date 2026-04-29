"use client";

import { useEffect, useMemo, useState } from "react";

import type { EntityType, Runtime } from "@/lib/types";
import type { ZyndImage } from "@/lib/images";

interface Props {
  runtime: Runtime;
  entityType: EntityType;
  /** Currently selected image ref (e.g. "zynd-deployer/agent-base:latest"). */
  value: string | null;
  /** Called when the user picks a different image, or when auto-default kicks in. */
  onChange: (ref: string | null) => void;
}

interface ApiResponse {
  images?: ZyndImage[];
  error?: string;
}

/**
 * Renders a dropdown of Zynd-labelled images on the deployer host,
 * scoped to the detected runtime + entity type. Auto-selects the
 * first base-flavor image matching the filter so the user never has
 * to think about it for the common case.
 *
 * Renders nothing visible while loading; shows a tiny error band if
 * /api/images fails so the deploy page is never broken by image
 * discovery problems — the worker still has a per-runtime default.
 */
export function ImagePicker({ runtime, entityType, value, onChange }: Props) {
  const [images, setImages] = useState<ZyndImage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setImages(null);
    fetch("/api/images")
      .then(async (r) => {
        const data: ApiResponse = await r.json();
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        if (!cancelled) setImages(data.images ?? []);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!images) return [];
    return images.filter((i) => i.runtime === runtime && i.kind === entityType);
  }, [images, runtime, entityType]);

  // Auto-select the base flavor (or first available) any time the
  // filter changes and the current value is no longer in the list.
  useEffect(() => {
    if (!images) return;
    if (filtered.length === 0) {
      if (value !== null) onChange(null);
      return;
    }
    const stillValid = filtered.some((i) => i.ref === value);
    if (stillValid) return;
    const base = filtered.find((i) => i.flavor === "base") ?? filtered[0];
    onChange(base.ref);
    // We deliberately depend on the filtered identity (changes when
    // runtime/entityType flips), not on `value`, to avoid a feedback
    // loop with the parent's onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);

  if (error) {
    return (
      <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
        Could not load image list: {error}. The deployer will fall back to the
        default base image.
      </div>
    );
  }

  if (!images) {
    return (
      <div className="text-xs text-white/40">Loading available images…</div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="rounded border border-white/10 bg-white/[0.03] p-3 text-xs text-white/50">
        No <span className="text-white/80">{runtime}</span>{" "}
        <span className="text-white/80">{entityType}</span> images found on the
        deployer host. Build one with{" "}
        <code className="text-white/70">
          docker build -f images/Dockerfile.{runtime === "node" ? "node-" : ""}
          {entityType}-base ...
        </code>
        .
      </div>
    );
  }

  const selected = filtered.find((i) => i.ref === value) ?? null;

  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-white/70">
        Container image
      </label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-zynd-purple"
      >
        {filtered.map((img) => (
          <option key={img.id} value={img.ref} className="bg-zinc-900">
            {img.display}
            {img.flavor !== "base" ? ` · ${img.flavor}` : ""}
          </option>
        ))}
      </select>
      {selected && (
        <p className="text-[11px] text-white/40">
          {selected.description ?? "No description"} ·{" "}
          <code className="text-white/60">{selected.ref}</code>
        </p>
      )}
    </div>
  );
}
