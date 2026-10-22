# 把规则裁决（HTML）与卡牌数据（cards.json）导出成 CSV，供表格生成技能作为素材读取。
# 用法：python tools/export_tables.py   → 输出到 <项目根>/_export/
import csv
import html as H
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = os.path.dirname(ROOT)                      # 行道开发/
OUT = os.path.join(PROJECT, "_export")
os.makedirs(OUT, exist_ok=True)


def strip_tags(s):
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = re.sub(r"</(p|div|li|tr)>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = H.unescape(s)
    return re.sub(r"[ \t]+", " ", s).strip()


def write_csv(name, header, rows):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    print(f"{name}  {len(rows)} 行")


# ---------- 1. 规则裁决 R01–R41 ----------
raw = open(os.path.join(PROJECT, "规则裁决与实现口径-v1.4.html"), encoding="utf-8").read()
blocks = re.findall(r"<h2><span class=\"num\">(\d+)</span>(.*?)</h2>", raw, re.S)
print("章节：", [f"{n}{strip_tags(t)}" for n, t in blocks])

rows = []
for tr in re.findall(r"<tr><td class=\"id\">(R\d+)</td>(.*?)</tr>", raw, re.S):
    rid, rest = tr
    tds = re.findall(r"<td[^>]*>(.*?)</td>", rest, re.S)
    title = strip_tags(tds[0]) if tds else ""
    if len(tds) >= 3:
        src = strip_tags(tds[1])
        body = strip_tags(tds[2])
    else:
        src = ""
        body = strip_tags(tds[1]) if len(tds) > 1 else ""
    rows.append([rid, title, src, body])
write_csv("01-规则裁决.csv", ["编号", "议题", "来源", "裁定与实现要点"], rows)


# ---------- 2. 卡牌 ----------
J = json.load(open(os.path.join(ROOT, "data", "cards.json"), encoding="utf-8"))

write_csv(
    "02-基础术.csv",
    ["ID", "名称", "类型", "消耗能量", "攻击数值", "防御阈值", "效果"],
    [[c["id"], c["name"], c["type"], c["cost"],
      "" if c["atk"] is None else c["atk"],
      "" if c["def"] is None else c["def"], c["text"]] for c in J["basic"]],
)

write_csv(
    "03-术集总览.csv",
    ["ID", "术集", "登场批次", "套系特点"],
    [[s["id"], s["name"], f"第 {s['batch']} 局起", s["passive"]] for s in J["sets"]],
)

set_rows = []
for s in J["sets"]:
    for c in s["cards"]:
        set_rows.append([
            s["name"], c["id"], c["name"], c["type"], c["cost"],
            "" if c["atk"] is None else c["atk"],
            "" if c["def"] is None else c["def"], c["text"],
        ])
write_csv("04-术集卡牌明细.csv",
          ["所属术集", "ID", "名称", "类型", "消耗能量", "攻击数值", "防御阈值", "效果"], set_rows)

write_csv(
    "05-天机.csv",
    ["ID", "天机", "效果", "权重", "触发条件", "类型", "设计备注"],
    [[t["id"], t["name"], t["effect"], t["weight"], t["condition"], t["type"], t["note"]]
     for t in J["tianji"]],
)

write_csv(
    "06-道牌.csv",
    ["生效顺序", "档位", "ID", "类别", "名称", "张数", "效果", "目标", "持续", "设计备注"],
    [[("被动" if d.get("order") is None else d["order"]), d.get("tier") or "被动触发（不占档位）",
      d["id"], d["category"], d["name"], d["copies"], d["text"], d["target"], d["duration"], d["note"]]
     for d in J["dao"]],
)

write_csv(
    "07-身世.csv",
    ["ID", "身世", "效果", "定位", "设计备注"],
    [[b["id"], b["name"], b["effect"], b["role"], b["note"]] for b in J["birth"]],
)
print("\n输出目录：", OUT)
