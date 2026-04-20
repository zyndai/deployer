"use client";

import { useCallback, useRef, useState } from "react";

export interface DropZoneProps {
  label: string;
  hint: string;
  /**
   * When true, the drop zone accepts a folder drop and hands back a
   * Map<relativePath, File>. Otherwise it accepts a single file and the
   * callback receives just the File.
   */
  folder?: boolean;
  accept?: string;              // MIME filter for the single-file mode
  onFiles: (files: File[] | Map<string, File>) => void;
  selectedSummary?: string;     // rendered after a selection is made
}

/**
 * Drag-drop + click-to-pick zone. Folder mode uses webkitdirectory on
 * the fallback <input>; dropping a folder into a modern browser walks
 * the DataTransferItem tree so sub-directories are preserved.
 */
export function DropZone({
  label,
  hint,
  folder,
  accept,
  onFiles,
  selectedSummary,
}: DropZoneProps) {
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFiles = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setActive(false);
      if (folder) {
        const items = Array.from(e.dataTransfer.items).filter(
          (i) => i.kind === "file"
        );
        const map = new Map<string, File>();
        for (const it of items) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entry = (it as any).webkitGetAsEntry?.();
          if (entry) {
            await walkEntry(entry, "", map);
          } else {
            const f = it.getAsFile();
            if (f) map.set(f.name, f);
          }
        }
        onFiles(map);
      } else {
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      }
    },
    [folder, onFiles]
  );

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (folder) {
      const map = new Map<string, File>();
      for (const f of files) {
        // webkitRelativePath gives "folder-name/foo/bar.py"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rel = (f as any).webkitRelativePath || f.name;
        map.set(rel, f);
      }
      onFiles(map);
    } else {
      onFiles(files);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setActive(true);
      }}
      onDragLeave={() => setActive(false)}
      onDrop={handleFiles}
      onClick={() => inputRef.current?.click()}
      className={`cursor-pointer rounded-lg border-2 border-dashed border-white/15 bg-white/5 p-8 text-center transition ${
        active ? "drop-active" : ""
      }`}
    >
      <div className="text-sm font-semibold text-white">{label}</div>
      <div className="mt-1 text-xs text-white/50">{hint}</div>
      {selectedSummary && (
        <div className="mt-4 inline-flex rounded-md bg-zynd-purple/20 px-3 py-1.5 text-xs text-zynd-purple">
          {selectedSummary}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={accept}
        multiple={!!folder}
        // @ts-expect-error webkitdirectory is non-standard but supported
        webkitdirectory={folder ? "" : undefined}
        onChange={onPick}
      />
    </div>
  );
}

// Recurse a FileSystemEntry tree and flatten into a relative-path map.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function walkEntry(entry: any, base: string, map: Map<string, File>) {
  if (entry.isFile) {
    await new Promise<void>((resolve) => {
      entry.file((f: File) => {
        map.set(`${base}${f.name}`, f);
        resolve();
      });
    });
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    await new Promise<void>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reader.readEntries(async (entries: any[]) => {
        for (const e of entries) {
          await walkEntry(e, `${base}${entry.name}/`, map);
        }
        resolve();
      });
    });
  }
}
