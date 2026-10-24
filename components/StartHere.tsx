import Link from "next/link";

/** A suggested order for someone starting from zero, mixing the tracks so each lesson builds on the last. */
const PATH: { code: string; slug: string; why: string }[] = [
  { code: "A0", slug: "a0-foundations", why: "What a request is, and how to read the lab" },
  { code: "A1", slug: "a1-requests", why: "Why busy servers get slow" },
  { code: "C1", slug: "c1-cloud-basics", why: "Your first terminal and AWS commands" },
  { code: "A2", slug: "a2-load-balancing", why: "More than one server" },
  { code: "C2", slug: "c2-s3", why: "Storing files on AWS" },
  { code: "A3", slug: "a3-caching", why: "Making reads cheap" },
  { code: "C3", slug: "c3-iam", why: "Permissions, and reading AccessDenied" },
  { code: "A4", slug: "a4-replication", why: "Copies of your data" },
  { code: "A6", slug: "a6-queues", why: "Queues as shock absorbers" },
  { code: "C4", slug: "c4-sqs", why: "Real queues on AWS" },
  { code: "C5", slug: "c5-sns", why: "One event, many listeners" },
  { code: "C6", slug: "c6-dynamodb", why: "A database with no servers" },
  { code: "C7", slug: "c7-lambda", why: "Code without servers" },
  { code: "C8", slug: "c8-serverless-api", why: "Build a whole API" },
  { code: "B0", slug: "b0-foundations", why: "Messages, and your first protocol" },
];

export function StartHere() {
  return (
    <section className="mb-12 rounded-lg border border-line bg-panel px-5 py-5" aria-labelledby="start-here">
      <h2 id="start-here" className="text-xl font-semibold tracking-tight">
        New to all of this? Start here
      </h2>
      <p className="text-muted mt-1 max-w-[70ch]">
        Every track starts from zero, so you can begin anywhere. If you'd like a path, this order mixes them so each lesson uses what the last one taught. After it,
        carry on with the rest of each track in order. Words you don't know are in the{" "}
        <Link href="/glossary/" className="text-accent hover:underline">
          glossary
        </Link>
        .
      </p>
      <ol className="mt-4 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3 text-[14px]">
        {PATH.map((p, i) => (
          <li key={p.slug} className="flex gap-2">
            <span className="num text-muted w-5 text-right shrink-0">{i + 1}.</span>
            <Link href={`/learn/${p.slug}/`} className="hover:text-accent">
              <span className="num text-signal mr-1.5">{p.code}</span>
              {p.why}
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
