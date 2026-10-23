// Markdown → HTML for documents that came from uploads (consent forms): raw HTML is shown as text,
// links are limited to http(s)/mailto/tel and open in a new tab, images are dropped.
import { Marked, type Tokens } from 'marked';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const safe = new Marked({ gfm: true, breaks: false });
safe.use({
  renderer: {
    html(t: Tokens.HTML | Tokens.Tag) {
      return esc(t.text);
    },
    link(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, t: Tokens.Link) {
      const text = this.parser.parseInline(t.tokens);
      const href = (t.href || '').trim();
      if (!/^(https?:|mailto:|tel:)/i.test(href)) return text;
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image(t: Tokens.Image) {
      return esc(t.text || '');
    },
  },
});

export function safeMarkdown(md: string): string {
  return safe.parse(md || '', { async: false }) as string;
}
