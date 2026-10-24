import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { AwsLab } from "@/engine/aws/shell";
import { freshState } from "@/engine/aws/state";

/**
 * Runs every command in every AWS lesson, in order, the way a learner who
 * clicks every "Try it" (and every "Save as" file) would. Only the failures
 * a lesson sets up on purpose are allowed.
 */
const INTENDED: Record<string, RegExp[]> = {
  "c1-cloud-basics": [],
  "c2-s3": [/curl https:\/\/asha-notes-2026/],
  "c3-iam": [/aws s3 ls --profile intern/],
  "c4-sqs": [],
  "c5-sns": [],
  "c6-dynamodb": [/--condition-expression/],
  "c7-lambda": [],
  "c8-serverless-api": [/^curl https:\/\/\$API/, /^curl -X POST/],
  "c9-websites": [/^curl https:\/\/\$CF$/],
  "c10-eventbridge": [/aws logs tail \/aws\/lambda\/nightly-report/, /rate\(1 minutes\)/],
  "c11-step-functions": [],
  "c12-mystery": [/aws lambda invoke --function-name save-order/, /aws lambda get-policy --function-name nightly-cleanup/],
};

type Item = { kind: "cmd"; text: string } | { kind: "file"; name: string; text: string };

function items(mdx: string): Item[] {
  const out: Item[] = [];
  const re = /<Cmd>([\s\S]*?)<\/Cmd>|<CodeFile name="([^"]+)">([\s\S]*?)<\/CodeFile>/g;
  const unwrap = (c: string) => {
    c = c.trim();
    return c.startsWith("{`") ? c.slice(2, -2) : c;
  };
  let m;
  while ((m = re.exec(mdx))) {
    if (m[1] !== undefined) out.push({ kind: "cmd", text: unwrap(m[1]).replace(/\\\\/g, "\\") });
    else out.push({ kind: "file", name: m[2], text: m[3].replace(/^[\s\S]*?```\w*\n/, "").replace(/\n```[\s\S]*$/, "") + "\n" });
  }
  return out;
}

describe("every AWS lesson's commands work as written", () => {
  for (const [slug, intended] of Object.entries(INTENDED)) {
    it(slug, async () => {
      const lab = new AwsLab(freshState());
      const failures: string[] = [];
      const allowed = intended.map(() => 0);
      for (const it of items(readFileSync(`content/aws/${slug}.mdx`, "utf8"))) {
        if (it.kind === "file") {
          lab.state.files[`${lab.state.cwd}/${it.name}`] = it.text;
          continue;
        }
        const cmd = it.text.replace(/yourname/g, "asha");
        const r = await lab.exec(cmd);
        const out = r.chunks.filter((c) => c.stream === "out").map((c) => c.text).join("");
        const err = r.chunks.filter((c) => c.stream === "err").map((c) => c.text).join("");
        if (r.code === 0 && !/<Error>|Internal Server Error|"FunctionError"/.test(out)) continue;
        // Each intended failure may happen at most once... except the 500s in C8, which happen twice by design.
        const i = intended.findIndex((re) => re.test(cmd));
        if (i >= 0 && allowed[i] < 2) {
          allowed[i]++;
          continue;
        }
        failures.push(`$ ${cmd}\n${(err || out).trim().slice(0, 300)}`);
      }
      expect(failures, failures.join("\n\n")).toEqual([]);
    });
  }
});
