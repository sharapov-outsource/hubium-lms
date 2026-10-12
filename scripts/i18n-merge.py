#!/usr/bin/env python3
"""Deep-merges a JSON patch {"ru": {...}, "en": {...}} into packages/i18n/messages/*.json.

Usage: python3 scripts/i18n-merge.py patch.json
"""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent / 'packages' / 'i18n' / 'messages'


def merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            merge(dst[k], v)
        else:
            dst[k] = v


patch = json.loads(Path(sys.argv[1]).read_text())
for locale, data in patch.items():
    p = root / f'{locale}.json'
    cur = json.loads(p.read_text())
    merge(cur, data)
    p.write_text(json.dumps(cur, ensure_ascii=False, indent=2) + '\n')
print('merged', ', '.join(patch))
