export function renderMarkdown(text) {
  if (!text) return '';
  return marked.parse(text);
}
