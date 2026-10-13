import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Markdown for AI answers and notices: no raw HTML, a small element allowlist, and links
// that open safely.
const allowed = [
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'blockquote',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr',
];

export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-sm grid gap-2 text-sm leading-relaxed [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:scrollbar-hairline [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2 [&_table]:text-xs [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={allowed}
        unwrapDisallowed
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} className="text-accent underline" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
