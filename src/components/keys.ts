/** True when a key event comes from a text field (so global shortcuts should ignore it). */
export function isTyping(e: KeyboardEvent): boolean {
  const t = e.target;
  return t instanceof Element && !!t.closest('input, textarea, select, [contenteditable="true"]');
}
