import Link from "next/link";
import { ContinueButton } from "@/components/ContinueButton";
import { HeroDemo } from "@/components/HeroDemo";
import { ProgressBackup } from "@/components/ProgressBackup";
import { Roadmap } from "@/components/Roadmap";
import { StartHere } from "@/components/StartHere";

export default function Home() {
  return (
    <div className="w-full max-w-6xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
      <section className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-center mb-16">
        <div>
          <h1 className="text-[2.4rem] sm:text-[2.9rem] leading-[1.08] font-semibold tracking-tight">
            Build it, load it, and watch where it gives.
          </h1>
          <p className="text-muted text-[17px] mt-4 max-w-[46ch]">
            Every lesson is something live: a system you can overload, protocol code a checker tries to break, or a practice AWS
            account you build in. The traffic on the right is running now: every ten seconds a spike hits, and you can watch the
            servers absorb it.
          </p>
          <div className="flex flex-wrap gap-3 mt-7">
            <ContinueButton />
            <Link href="/sandbox/" className="px-4 py-2.5 rounded-md border border-line hover:bg-panel-2">
              Open the sandbox
            </Link>
          </div>
        </div>
        <HeroDemo />
      </section>
      <StartHere />
      <Roadmap />
      <ProgressBackup />
    </div>
  );
}
