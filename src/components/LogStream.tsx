"use client";

import { useEffect, useRef, useState } from "react";

interface LogEvent {
  lineNo: number;
  text: string;
  stream: "stdout" | "stderr" | "system";
  ts: string;
}

const STREAM_STYLES: Record<LogEvent["stream"], string> = {
  stdout: "text-white/80",
  stderr: "text-rose-300",
  system: "text-zynd-amber",
};

export function LogStream({ deploymentId }: { deploymentId: string }) {
  const [lines, setLines] = useState<LogEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/deployments/${deploymentId}/logs/stream`);

    es.addEventListener("log", (ev: MessageEvent) => {
      try {
        const line = JSON.parse(ev.data) as LogEvent;
        setLines((prev) => {
          // De-dupe on lineNo — initial dump and live tail can overlap.
          if (prev.length && prev[prev.length - 1].lineNo >= line.lineNo) {
            return prev;
          }
          return [...prev, line];
        });
      } catch {
        // ignore
      }
    });

    es.addEventListener("ready", () => setConnected(true));
    es.addEventListener("done", (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as { status: string };
        setDone(payload.status);
      } catch {
        setDone("closed");
      }
      es.close();
    });
    es.onerror = () => setConnected(false);

    return () => es.close();
  }, [deploymentId]);

  useEffect(() => {
    if (boxRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-white/40">
        <span>
          {connected ? "Streaming" : "Connecting…"}
          {done ? ` · stream closed (${done})` : ""}
        </span>
        <span>{lines.length} lines</span>
      </div>
      <div
        ref={boxRef}
        className="log-scroll h-96 overflow-auto rounded-lg border border-white/10 bg-black/50 p-3 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 ? (
          <div className="text-white/40">No logs yet.</div>
        ) : (
          lines.map((l) => (
            <div key={l.lineNo} className={`whitespace-pre-wrap ${STREAM_STYLES[l.stream]}`}>
              <span className="mr-2 text-white/30">
                {new Date(l.ts).toLocaleTimeString()}
              </span>
              {l.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
