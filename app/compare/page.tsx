import { CompareView } from "@/components/compare/CompareView";

export const metadata = { title: "Compare designs | SysLabLearns" };

export default function ComparePage() {
  return (
    <div className="w-full max-w-7xl mx-auto px-5 sm:px-8 py-8">
      <h1 className="text-[1.8rem] font-semibold tracking-tight">Compare two designs</h1>
      <p className="text-muted mt-1 mb-6 max-w-[70ch]">Run two versions of your sandbox design on the same traffic, then throw the same events at both and see which holds up, and at what cost.</p>
      <CompareView />
    </div>
  );
}
