/** A short aside in a lesson: the idea in one sentence, or a real-world parallel. */
export function Note({ children }: { children: React.ReactNode }) {
  return <aside className="my-5 border-l-2 border-accent pl-4 text-[15px] text-muted [&>p]:mb-0">{children}</aside>;
}
