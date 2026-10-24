"use client";

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { tags as t } from "@lezer/highlight";

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword], color: "var(--accent)" },
  { tag: [t.string, t.special(t.string)], color: "var(--signal)" },
  { tag: [t.number, t.bool, t.null], color: "var(--series-2)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--series-4)" },
  { tag: [t.propertyName], color: "var(--text)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--muted)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", background: "var(--panel)", color: "var(--text)", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--accent)", padding: "10px 0" },
  ".cm-gutters": { background: "var(--panel)", color: "var(--muted)", border: "none", borderRight: "1px solid var(--line)" },
  ".cm-activeLine": { background: "color-mix(in srgb, var(--panel-2) 70%, transparent)" },
  ".cm-activeLineGutter": { background: "var(--panel-2)", color: "var(--text)" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { background: "color-mix(in srgb, var(--accent) 28%, transparent) !important" },
  ".cm-matchingBracket": { background: "color-mix(in srgb, var(--accent) 22%, transparent)", outline: "none" },
  "&.cm-focused": { outline: "none" },
});

/** CodeMirror, themed with the app's tokens. Uncontrolled after mount: `value` only seeds it (and resets it when `resetKey` changes). */
export function CodeEditor({ value, onChange, resetKey }: { value: string; onChange: (code: string) => void; resetKey: number }) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          javascript({ typescript: true }),
          syntaxHighlighting(highlight),
          keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorState.tabSize.of(2),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ "aria-label": "Your protocol code" }),
        ],
      }),
    });
    return () => view.destroy();
    // Recreate only on an explicit reset; typing must not rebuild the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
