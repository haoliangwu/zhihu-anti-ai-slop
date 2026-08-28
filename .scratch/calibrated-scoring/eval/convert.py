#!/usr/bin/env python3
"""C-ReD question-answer CSV → dataset.jsonl（text + label）。
label: 1 = 人类，0 = AI。仅保留 text/label 两列，供 Node 特征提取使用。
"""
import csv
import glob
import json
import os

DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
OUT = os.path.join(os.path.dirname(__file__), 'dataset.jsonl')


def main():
    rows = 0
    with open(OUT, 'w', encoding='utf-8') as out:
        for f in sorted(glob.glob(os.path.join(DATA_DIR, 'CReD_question_answer_*.csv'))):
            kind = 'human' if 'human' in os.path.basename(f) else 'ai'
            label = 1 if kind == 'human' else 0
            with open(f, encoding='utf-8') as fh:
                for row in csv.DictReader(fh):
                    text = (row.get('text') or '').strip()
                    if not text:
                        continue
                    out.write(json.dumps({'text': text, 'label': label}, ensure_ascii=False) + '\n')
                    rows += 1
    print(f'written {rows} rows -> {OUT}')


if __name__ == '__main__':
    main()
