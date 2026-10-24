import { AwsLab } from "@/engine/aws/shell";
import { freshState } from "@/engine/aws/state";

export function lab() {
  const l = new AwsLab(freshState());
  const run = async (line: string) => {
    const r = await l.exec(line);
    const out = r.chunks.filter((c) => c.stream === "out").map((c) => c.text).join("");
    const err = r.chunks.filter((c) => c.stream === "err").map((c) => c.text).join("");
    return {
      out,
      err,
      code: r.code,
      json: () => {
        try {
          return JSON.parse(out);
        } catch {
          throw new Error(`Not JSON for: ${line}\nstdout: ${out}\nstderr: ${err}`);
        }
      },
    };
  };
  return { l, run };
}
