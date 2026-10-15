'use client';

import type { AutoLink } from '@hubium/module-sdk';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef } from 'react';
import { findLink, type LinkTerm, linkTerms } from '@/lib/auto-links';

/** Texts that are not linked: the glossary itself, quizzes (links could give answers away), editors. */
const SKIP_TEXT =
  '[contenteditable], [data-no-autolink], [data-module="quiz"], [data-module="glossary"]';
/** Elements inside a text whose words stay as they are. */
const SKIP_INSIDE =
  'a, code, pre, kbd, samp, script, style, textarea, button, select, svg, math, .katex, [data-latex], [data-no-autolink]';

/**
 * Links the words of glossary entries (and any module's auto-links) in the rich texts below
 * it: the first place each entry's word shows up in a text, as the page renders and changes.
 */
export function AutoLinks({ links, children }: { links: AutoLink[]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  useEffect(() => {
    const root = ref.current;
    if (!root || !links.length) return;
    const terms = linkTerms(links);
    const urls = new Set(terms.map((t) => t.url));
    let frame = 0;
    const scan = () => {
      frame = 0;
      // only RichText's HTML: text that React renders itself must stay as React left it
      for (const box of root.querySelectorAll<HTMLElement>('[data-rich-text]'))
        if (!box.closest(SKIP_TEXT)) linkText(box, terms, urls.size);
    };
    // React re-renders texts and pages change under the layout: link what appears
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(scan);
    });
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[data-autolink]');
      if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      router.push(a.getAttribute('href') ?? '/');
    };
    scan();
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    root.addEventListener('click', onClick);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      root.removeEventListener('click', onClick);
    };
  }, [links, router]);
  return <div ref={ref}>{children}</div>;
}

function linkText(box: HTMLElement, terms: LinkTerm[], pages: number) {
  const used = new Set(
    [...box.querySelectorAll('a[data-autolink]')].map((a) => a.getAttribute('href') ?? ''),
  );
  if (used.size >= pages) return;
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const skip = n.parentElement?.closest(SKIP_INSIDE);
      if (skip && box.contains(skip)) return NodeFilter.FILTER_REJECT;
      return n.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (let node of nodes) {
    for (;;) {
      if (used.size >= pages) return;
      const m = findLink(node.data, terms, used);
      if (!m) break;
      const word = node.splitText(m.start);
      node = word.splitText(m.end - m.start);
      const a = document.createElement('a');
      a.href = m.term.url;
      a.title = m.term.title;
      a.dataset.autolink = '';
      word.replaceWith(a);
      a.append(word);
      used.add(m.term.url);
    }
  }
}
