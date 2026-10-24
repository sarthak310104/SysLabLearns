import { ProgressView } from "@/components/ProgressView";

export const metadata = { title: "Progress | SysLabLearns" };

export default function ProgressPage() {
  return (
    <div className="w-full max-w-3xl mx-auto px-5 sm:px-8 py-10">
      <h1 className="text-[2rem] font-semibold tracking-tight">Progress</h1>
      <p className="text-muted mt-2 mb-8">What you've done so far, kept in this browser. Back it up from the roadmap page if you switch devices.</p>
      <ProgressView />
    </div>
  );
}
