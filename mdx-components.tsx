import type { MDXComponents } from "mdx/types";
import { Goals } from "@/components/lesson/Goals";
import { Note } from "@/components/lesson/Note";
import { Quiz } from "@/components/lesson/Quiz";

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return { ...components, Goals, Note, Quiz };
}
