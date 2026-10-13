'use client';

import { Button, Checkbox, Textarea } from '@hubium/ui';
import { Dialog, DialogContent, DialogFooter } from '@hubium/ui/dialog';
import Image from '@tiptap/extension-image';
import Mathematics from '@tiptap/extension-mathematics';
import Placeholder from '@tiptap/extension-placeholder';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { EditorContent, mergeAttributes, Node, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import katex from 'katex';
import {
  Bold,
  Code,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Sigma,
  Table2,
  Undo2,
  Video,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

/** Video embed (YouTube, RuTube, VK Video, Vimeo). The server re-validates the host. */
const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  addAttributes() {
    return { src: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'iframe[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'iframe',
      mergeAttributes(HTMLAttributes, {
        width: '640',
        height: '360',
        allowfullscreen: 'true',
        allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture',
        loading: 'lazy',
        title: 'video',
      }),
    ];
  },
});

export interface RichTextLabels {
  bold: string;
  italic: string;
  heading2: string;
  heading3: string;
  bulletList: string;
  orderedList: string;
  quote: string;
  code: string;
  link: string;
  linkPrompt: string;
  image: string;
  video: string;
  videoPrompt: string;
  videoInvalid: string;
  table: string;
  formula: string;
  formulaLatex: string;
  formulaBlock: string;
  formulaPreview: string;
  insert: string;
  remove: string;
  cancel: string;
  undo: string;
  redo: string;
}

export const defaultLabels: RichTextLabels = {
  bold: 'Bold',
  italic: 'Italic',
  heading2: 'Heading',
  heading3: 'Subheading',
  bulletList: 'Bulleted list',
  orderedList: 'Numbered list',
  quote: 'Quote',
  code: 'Code block',
  link: 'Link',
  linkPrompt: 'Link URL',
  image: 'Image',
  video: 'Video',
  videoPrompt: 'Video URL (YouTube, RuTube, VK Video, Vimeo)',
  videoInvalid: 'Unsupported video link',
  table: 'Table',
  formula: 'Formula',
  formulaLatex: 'Formula in LaTeX, for example \\frac{a}{b}',
  formulaBlock: 'On a line of its own',
  formulaPreview: 'Preview',
  insert: 'Insert',
  remove: 'Remove',
  cancel: 'Cancel',
  undo: 'Undo',
  redo: 'Redo',
};

const KATEX = { throwOnError: false, strict: false, trust: false } as const;

/** A formula being written: new (pos null) or an existing node at `pos`. */
type FormulaDraft = { latex: string; block: boolean; pos: number | null };

function FormulaDialog({
  draft,
  labels,
  onClose,
  onSave,
  onRemove,
}: {
  draft: FormulaDraft | null;
  labels: RichTextLabels;
  onClose: () => void;
  onSave: (d: FormulaDraft) => void;
  onRemove: (d: FormulaDraft) => void;
}) {
  const [latex, setLatex] = useState('');
  const [block, setBlock] = useState(false);
  const id = useId();
  useEffect(() => {
    if (draft) {
      setLatex(draft.latex);
      setBlock(draft.block);
    }
  }, [draft]);
  const preview = latex.trim() ? katex.renderToString(latex, { ...KATEX, displayMode: block }) : '';
  return (
    <Dialog open={!!draft} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent title={labels.formula} closeLabel={labels.cancel}>
        <div className="grid gap-3">
          <label htmlFor={`${id}-latex`} className="text-sm font-medium">
            {labels.formulaLatex}
          </label>
          <Textarea
            id={`${id}-latex`}
            rows={3}
            className="font-mono"
            value={latex}
            onChange={(e) => setLatex(e.target.value)}
            autoFocus
          />
          {draft?.pos === null ? (
            <label htmlFor={`${id}-block`} className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`${id}-block`}
                checked={block}
                onChange={(e) => setBlock(e.target.checked)}
              />
              {labels.formulaBlock}
            </label>
          ) : null}
          <div
            aria-label={labels.formulaPreview}
            role="img"
            className="min-h-12 overflow-x-auto rounded-md border border-border p-3"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX output with trust: false
            dangerouslySetInnerHTML={{ __html: preview }}
          />
        </div>
        <DialogFooter>
          {draft && draft.pos !== null ? (
            <Button type="button" variant="ghost" onClick={() => onRemove(draft)}>
              {labels.remove}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button
            type="button"
            disabled={!latex.trim()}
            onClick={() => draft && onSave({ latex: latex.trim(), block, pos: draft.pos })}
          >
            {draft?.pos === null ? labels.insert : labels.formula}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Client-side counterpart of toEmbedUrl (kept in sync with ./server.ts). */
function embedUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^m\./, '');
    if (host === 'youtu.be') return `https://www.youtube-nocookie.com/embed/${u.pathname.slice(1)}`;
    if (host.endsWith('youtube.com')) {
      const id =
        u.searchParams.get('v') ??
        (u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : null);
      return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
    }
    if (host === 'rutube.ru') {
      const m = /\/video\/([0-9a-f]{32})/.exec(u.pathname);
      return m ? `https://rutube.ru/play/embed/${m[1]}` : null;
    }
    if (host === 'vk.com' || host === 'vkvideo.ru') {
      const m = /video(-?\d+)_(\d+)/.exec(u.pathname + u.search);
      return m ? `https://vkvideo.ru/video_ext.php?oid=${m[1]}&id=${m[2]}&hd=2` : null;
    }
    if (host === 'vimeo.com') {
      const m = /^\/(\d+)/.exec(u.pathname);
      return m ? `https://player.vimeo.com/video/${m[1]}` : null;
    }
  } catch {}
  return null;
}

function ToolButton({
  label,
  active,
  onClick,
  children,
  disabled,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 aria-pressed:bg-accent-soft aria-pressed:text-accent [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

export function RichTextEditor({
  name,
  defaultValue = '',
  placeholder,
  labels = defaultLabels,
  uploadImage,
  id,
  minHeight = 160,
  ariaLabel,
  onChangeHtml,
}: {
  name: string;
  defaultValue?: string;
  placeholder?: string;
  labels?: RichTextLabels;
  /** Returns the URL of the uploaded image. */
  uploadImage?: (file: File) => Promise<string>;
  id?: string;
  minHeight?: number;
  ariaLabel?: string;
  /** Called with the current HTML on every change. */
  onChangeHtml?: (html: string) => void;
}) {
  const [html, setHtml] = useState(defaultValue);
  const [formula, setFormula] = useState<FormulaDraft | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const autoId = useId();
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] },
      }),
      Placeholder.configure({ placeholder: placeholder ?? '' }),
      Image,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Embed,
      Mathematics.configure({
        katexOptions: KATEX,
        inlineOptions: {
          onClick: (node, pos) => setFormula({ latex: node.attrs.latex, block: false, pos }),
        },
        blockOptions: {
          onClick: (node, pos) => setFormula({ latex: node.attrs.latex, block: true, pos }),
        },
      }),
    ],
    content: defaultValue,
    editorProps: {
      attributes: {
        class: 'prose-content min-h-[var(--editor-min)] px-3 py-2 outline-none',
        id: id ?? autoId,
        'aria-label': ariaLabel ?? name,
        'aria-multiline': 'true',
        role: 'textbox',
      },
    },
    onUpdate: ({ editor: e }) => {
      const value = e.isEmpty ? '' : e.getHTML();
      setHtml(value);
      onChangeHtml?.(value);
    },
  });

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            h2: e.isActive('heading', { level: 2 }),
            h3: e.isActive('heading', { level: 3 }),
            ul: e.isActive('bulletList'),
            ol: e.isActive('orderedList'),
            quote: e.isActive('blockquote'),
            code: e.isActive('codeBlock'),
            link: e.isActive('link'),
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
          }
        : null,
  });

  const chain = () => editor!.chain().focus();

  return (
    <div
      className="rounded-md border border-input bg-background focus-within:ring-2 focus-within:ring-ring/40"
      style={{ ['--editor-min' as string]: `${minHeight}px` }}
    >
      <div
        role="toolbar"
        aria-label={ariaLabel ?? name}
        className="flex flex-wrap gap-0.5 border-b border-border p-1"
      >
        <ToolButton
          label={labels.bold}
          active={state?.bold}
          onClick={() => chain().toggleBold().run()}
        >
          <Bold />
        </ToolButton>
        <ToolButton
          label={labels.italic}
          active={state?.italic}
          onClick={() => chain().toggleItalic().run()}
        >
          <Italic />
        </ToolButton>
        <ToolButton
          label={labels.heading2}
          active={state?.h2}
          onClick={() => chain().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 />
        </ToolButton>
        <ToolButton
          label={labels.heading3}
          active={state?.h3}
          onClick={() => chain().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 />
        </ToolButton>
        <ToolButton
          label={labels.bulletList}
          active={state?.ul}
          onClick={() => chain().toggleBulletList().run()}
        >
          <List />
        </ToolButton>
        <ToolButton
          label={labels.orderedList}
          active={state?.ol}
          onClick={() => chain().toggleOrderedList().run()}
        >
          <ListOrdered />
        </ToolButton>
        <ToolButton
          label={labels.quote}
          active={state?.quote}
          onClick={() => chain().toggleBlockquote().run()}
        >
          <Quote />
        </ToolButton>
        <ToolButton
          label={labels.code}
          active={state?.code}
          onClick={() => chain().toggleCodeBlock().run()}
        >
          <Code />
        </ToolButton>
        <ToolButton
          label={labels.link}
          active={state?.link}
          onClick={() => {
            if (editor?.isActive('link')) return chain().unsetLink().run();
            const url = window.prompt(labels.linkPrompt, 'https://');
            if (url && /^(https?:|mailto:)/.test(url))
              chain().extendMarkRange('link').setLink({ href: url }).run();
          }}
        >
          <Link2 />
        </ToolButton>
        <ToolButton
          label={labels.image}
          onClick={() => {
            if (uploadImage) fileRef.current?.click();
            else {
              const url = window.prompt(labels.image, 'https://');
              if (url) chain().setImage({ src: url }).run();
            }
          }}
        >
          <ImagePlus />
        </ToolButton>
        <ToolButton
          label={labels.video}
          onClick={() => {
            const url = window.prompt(labels.videoPrompt, 'https://');
            if (!url) return;
            const src = embedUrl(url);
            if (!src) return window.alert(labels.videoInvalid);
            chain().insertContent({ type: 'embed', attrs: { src } }).run();
          }}
        >
          <Video />
        </ToolButton>
        <ToolButton
          label={labels.table}
          onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
        >
          <Table2 />
        </ToolButton>
        <ToolButton
          label={labels.formula}
          onClick={() => setFormula({ latex: '', block: false, pos: null })}
        >
          <Sigma />
        </ToolButton>
        <span className="flex-1" />
        <ToolButton
          label={labels.undo}
          disabled={!state?.canUndo}
          onClick={() => chain().undo().run()}
        >
          <Undo2 />
        </ToolButton>
        <ToolButton
          label={labels.redo}
          disabled={!state?.canRedo}
          onClick={() => chain().redo().run()}
        >
          <Redo2 />
        </ToolButton>
      </div>
      <EditorContent editor={editor} />
      <input type="hidden" name={name} value={html} />
      <FormulaDialog
        draft={formula}
        labels={labels}
        onClose={() => setFormula(null)}
        onSave={(d) => {
          const c = chain();
          if (d.pos === null)
            (d.block
              ? c.insertBlockMath({ latex: d.latex })
              : c.insertInlineMath({ latex: d.latex })
            ).run();
          else
            (d.block
              ? c.updateBlockMath({ latex: d.latex, pos: d.pos })
              : c.updateInlineMath({ latex: d.latex, pos: d.pos })
            ).run();
          setFormula(null);
        }}
        onRemove={(d) => {
          const c = chain();
          (d.block
            ? c.deleteBlockMath({ pos: d.pos! })
            : c.deleteInlineMath({ pos: d.pos! })
          ).run();
          setFormula(null);
        }}
      />
      {uploadImage ? (
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          tabIndex={-1}
          aria-hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            const src = await uploadImage(f);
            chain().setImage({ src, alt: f.name }).run();
          }}
        />
      ) : null}
    </div>
  );
}

/** Renders sanitised HTML produced by the server; formulas are drawn by KaTeX. */
export function RichText({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new HTML means new formula nodes to draw
  useEffect(() => {
    const nodes = ref.current?.querySelectorAll<HTMLElement>(
      '[data-type="inline-math"][data-latex], [data-type="block-math"][data-latex]',
    );
    if (!nodes?.length) return;
    for (const el of nodes)
      katex.render(el.dataset.latex ?? '', el, {
        ...KATEX,
        displayMode: el.dataset.type === 'block-math',
      });
  }, [html]);
  return (
    <div
      ref={ref}
      className={`prose-content ${className ?? ''}`}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised on write by sanitizeRichText
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
