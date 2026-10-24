import { ReviewSession } from "@/components/ReviewSession";

export const metadata = { title: "Review | SysLabLearns" };

export default function ReviewPage() {
  return (
    <div className="w-full max-w-2xl mx-auto px-5 sm:px-8 py-10">
      <h1 className="text-[2rem] font-semibold tracking-tight">Review</h1>
      <p className="text-muted mt-2 mb-6">Quiz questions from lessons you've done, brought back just before you'd forget them.</p>
      <ReviewSession />
    </div>
  );
}
