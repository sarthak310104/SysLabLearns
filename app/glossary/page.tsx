import { GlossaryList } from "@/components/GlossaryList";

export const metadata = { title: "Glossary | SysLabLearns" };

export default function GlossaryPage() {
  return (
    <div className="w-full max-w-3xl mx-auto px-5 sm:px-8 py-10">
      <h1 className="text-[2rem] font-semibold tracking-tight">Glossary</h1>
      <p className="text-muted mt-2 mb-6">Every term the lessons use, in plain words, with the lesson that teaches it.</p>
      <GlossaryList />
    </div>
  );
}
