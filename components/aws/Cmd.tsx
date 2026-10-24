"use client";

import { useState } from "react";
import { awsBus } from "@/lib/awsBus";

function text(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(text).join("");
  if (children && typeof children === "object" && "props" in children) return text((children as { props: { children?: React.ReactNode } }).props.children);
  return "";
}

/** A command in the lesson: "Try it" puts it in the terminal so you can read it, change it and press Enter. */
export function Cmd({ children, note }: { children: React.ReactNode; note?: string }) {
  const cmd = text(children).replace(/^\n+|\n+$/g, "");
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-3 rounded-md border border-line bg-bg not-prose">
      <div className="flex items-start gap-2 px-3 py-2">
        <pre className="flex-1 min-w-0 whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed m-0">
          <span className="text-muted select-none">$ </span>
          {cmd}
        </pre>
        <div className="flex flex-col gap-1 shrink-0">
          <button className="btn-accent rounded px-2 py-0.5 text-[12px]" onClick={() => awsBus.insert(cmd.replace(/\s*\\\n\s*/g, " "))}>
            Try it
          </button>
          <button
            className="text-[11px] text-muted hover:text-text"
            onClick={() => {
              navigator.clipboard?.writeText(cmd).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {note && <p className="px-3 pb-2 text-[12px] text-muted">{note}</p>}
    </div>
  );
}

/** Running the same lesson against Floci, a free AWS emulator on your own computer. */
export function Floci({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const extra = text(children).replace(/^\n+|\n+$/g, "");
  return (
    <aside className="my-6 rounded-lg border border-line bg-panel">
      <button className="w-full flex items-center gap-2 px-4 py-3 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="font-semibold">Do it for real with Floci</span>
        <span className="text-[12px] text-muted">on your own computer, still free</span>
        <span className="ml-auto text-muted text-[13px]">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 text-[14px] space-y-3 border-t border-line pt-3">
          <p>
            <a href="https://floci.io" target="_blank" rel="noreferrer">
              Floci
            </a>{" "}
            runs an AWS look-alike in Docker on your machine, so the real AWS CLI works against it with no account and no bill. You need Docker Desktop and the AWS CLI v2 installed. In Git Bash:
          </p>
          <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] rounded-md bg-bg border border-line p-3 m-0">
            {`# Start Floci (the docker.sock mount lets it run Lambda functions in containers).
# The double slash stops Git Bash from rewriting the path on Windows.
docker run -d --name floci -p 4566:4566 -v //var/run/docker.sock:/var/run/docker.sock -u root floci/floci:latest

# Point the AWS CLI at it for this terminal session.
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=ap-south-1`}
          </pre>
          {extra && (
            <>
              <p>Then the commands from this lesson work as they are:</p>
              <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] rounded-md bg-bg border border-line p-3 m-0">{extra}</pre>
            </>
          )}
          <p className="text-[13px] text-muted">
            An emulator is very close to AWS but not identical: some error messages and permission checks differ. When you're done, docker rm -f floci stops it. To use real AWS later, unset AWS_ENDPOINT_URL and run aws configure with real keys.
          </p>
        </div>
      )}
    </aside>
  );
}

/** A file in the lesson: one click saves it into your practice account's home folder. */
export function CodeFile({ name, children }: { name: string; children: React.ReactNode }) {
  const content = text(children).replace(/^\n+/, "").replace(/\s+$/, "") + "\n";
  const [saved, setSaved] = useState(false);
  return (
    <div className="my-3 rounded-md border border-line bg-bg not-prose">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line text-[12px]">
        <span className="font-mono text-muted">{name}</span>
        <span className="flex-1" />
        <button
          className="btn-accent rounded px-2 py-0.5"
          onClick={() => {
            awsBus.saveFile(name, content);
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          }}
        >
          {saved ? "Saved" : `Save as ${name}`}
        </button>
        <button className="text-muted hover:text-text" onClick={() => navigator.clipboard?.writeText(content)}>
          Copy
        </button>
      </div>
      <pre className="whitespace-pre overflow-x-auto font-mono text-[12.5px] leading-relaxed m-0" style={{ padding: "8px 12px" }}>
        {content}
      </pre>
    </div>
  );
}
