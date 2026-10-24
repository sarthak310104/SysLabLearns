import Link from "next/link";
import { HeroDemo } from "@/components/HeroDemo";
import { ProgressBackup } from "@/components/ProgressBackup";
import { Roadmap } from "@/components/Roadmap";

export default function Home() {
  return (
    <div className="w-full max-w-6xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
      <section className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-center mb-16">
        <div>
          <h1 className="text-[2.4rem] sm:text-[2.9rem] leading-[1.08] font-semibold tracking-tight">
            Build it, load it, and watch where it gives.
          </h1>
          <p className="text-muted text-[17px] mt-4 max-w-[46ch]">
            Every lesson is a live system you can push until something breaks. The traffic on the right is running now: every
            ten seconds a spike hits, and you can watch the servers absorb it.
          </p>
          <div className="flex flex-wrap gap-3 mt-7">
            <Link href="/learn/a1-requests/" className="px-4 py-2.5 rounded-md bg-accent text-accent-ink font-medium neon">
              Start the first lesson
            </Link>
            <Link href="/sandbox/" className="px-4 py-2.5 rounded-md border border-line hover:bg-panel-2">
              Open the sandbox
            </Link>
          </div>
        </div>
        <HeroDemo />
      </section>
      <Roadmap />
      <ProgressBackup />
    </div>
  );
}
