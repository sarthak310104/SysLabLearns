import { InterviewList } from "@/components/interview/InterviewList";

export const metadata = { title: "Interview practice | SysLabLearns" };

export default function InterviewsPage() {
  return (
    <div className="w-full max-w-4xl mx-auto px-5 sm:px-8 py-10">
      <h1 className="text-[2rem] font-semibold tracking-tight">Interview practice</h1>
      <p className="text-muted mt-2 mb-8 max-w-[62ch]">
        A timed system design question, the way interviews run it: ask questions to find the real requirements, do the quick sums, build a design that
        meets them, then survive the interviewer's follow-up. You get a scorecard and one good answer at the end.
      </p>
      <InterviewList />
    </div>
  );
}
