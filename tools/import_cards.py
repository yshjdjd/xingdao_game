#!/usr/bin/env python3
"""卡牌.xlsx -> data/cards.json

策划只改 Excel，代码只消费生成物。这样"数值随时可微调"就是改一行 Excel + 跑一次本脚本。
用法: python tools/import_cards.py
"""
import json
import os
import re
import sys
from datetime import datetime

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
XLSX = os.path.join(os.path.dirname(ROOT), "卡牌.xlsx")
OUT = os.path.join(ROOT, "data", "cards.json")

BATCH_RE = re.compile(r"第([一二三四])批次")
SET_RE = re.compile(r"【(.+?)】")
CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4}
PENDING = ("待补", "待设计", "待定")


def cell(v):
    if v is None:
        return None
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def num(v):
    v = cell(v)
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v) if isinstance(v, float) and v != int(v) else v
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def is_pending(text):
    return bool(text) and any(p in str(text) for p in PENDING)


def rows(ws):
    return [[cell(c) for c in r] for r in ws.iter_rows(values_only=True)]


def import_basic(wb):
    out = []
    for r in rows(wb["基础术"])[1:]:
        if not r or not isinstance(r[0], int):
            continue
        out.append({
            "id": "base_%02d" % r[0],
            "name": r[1],
            "type": r[2],
            "cost": num(r[4]) or 0,
            "atk": num(r[5]),
            "def": num(r[6]),
            "text": r[9] or "",
        })
    return out


def import_sets(wb):
    sets = []
    cur_batch, cur = 0, None
    for r in rows(wb["术牌"]):
        if not r or all(v is None for v in r):
            continue
        c0, c1, c2, c3, c4, c5, c6, c7, c8 = (r + [None] * 9)[:9]

        if isinstance(c0, str):
            m = BATCH_RE.search(c0)
            if m:
                cur_batch = CN_NUM[m.group(1)]
        if isinstance(c1, str) and c1 not in ("术系名称",) and c3 is not None or (isinstance(c1, str) and c1 not in ("术系名称",) and c3 is None):
            m2 = SET_RE.search(c1 or "")
            name = m2.group(1) if m2 else c1
            cur = {
                "id": "b%ds%d" % (cur_batch, len([s for s in sets if s["batch"] == cur_batch]) + 1),
                "name": name,
                "batch": cur_batch,
                "passive": c2 or "",
                "cards": [],
            }
            sets.append(cur)
        if cur is None or c3 is None or c3 in ("名称", "（攻）", "（御）"):
            continue
        if is_pending(c3) or is_pending(c4):
            continue
        cur["cards"].append({
            "id": "%s_%02d" % (cur["id"], len(cur["cards"]) + 1),
            "name": c3,
            "type": c4,
            "cost": num(c7),
            "atk": num(c5),
            "def": num(c6),
            "text": c8 or "",
        })
    return [x for x in sets if x["cards"]]


def import_tianji(wb):
    out = []
    for r in rows(wb["天机牌"])[1:]:
        if not r or not isinstance(r[0], int):
            continue
        out.append({
            "id": "tj_%02d" % r[0],
            "name": r[1],
            "effect": r[2] or "",
            "weight": num(r[3]) or 0,
            "condition": r[5] or "",
            "type": r[6] or "",
            "note": r[7] or "",
        })
    return out


def import_dao(wb):
    out = []
    for r in rows(wb["道牌"])[1:]:
        if not r or not isinstance(r[0], int):
            continue
        out.append({
            "id": "dao_%02d" % r[0],
            "category": r[1],
            "name": r[2],
            "copies": int(r[3] or 1),
            "text": r[4] or "",
            "target": r[5] or "",
            "duration": r[6] or "",
            "note": r[7] or "",
        })
    return out


def import_birth(wb):
    out = []
    for r in rows(wb["身世牌"])[1:]:
        if not r or not isinstance(r[0], int):
            continue
        out.append({
            "id": "birth_%02d" % r[0],
            "name": r[1],
            "effect": r[2] or "",
            "role": r[3] or "",
            "note": r[4] or "",
        })
    return out


def main():
    if not os.path.exists(XLSX):
        sys.exit("找不到 %s" % XLSX)
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    data = {
        "ruleset": "1.3+dev",
        "generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        "source": "卡牌.xlsx",
        "basic": import_basic(wb),
        "sets": import_sets(wb),
        "tianji": import_tianji(wb),
        "dao": import_dao(wb),
        "birth": import_birth(wb),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    n_set_cards = sum(len(s["cards"]) for s in data["sets"])
    print("basic %d / sets %d (%d cards) / tianji %d / dao %d / birth %d"
          % (len(data["basic"]), len(data["sets"]), n_set_cards,
             len(data["tianji"]), len(data["dao"]), len(data["birth"])))
    for s in data["sets"]:
        print("  b%d %s：%d 张 %s" % (s["batch"], s["name"], len(s["cards"]),
                                      "/".join(c["name"] for c in s["cards"])))


if __name__ == "__main__":
    main()
