# -*- coding: utf-8 -*-
"""v1.4 卡牌数据变更（与规则裁决 R42–R45 对应）。

1. 删除身世 birth_07 天机门人（R42）
2. 新增神通牌 dao_32 窥天（R44）
3. 修改 dao_30 天命轮转为「下一回合必定天机动荡」（R45）
4. 修正 birth_03 官宦子弟文案：是「每局开局」不是「每回合」（R52）
5. effects.json 同步移除 birth_07

幂等：重复运行不会重复插入。
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, "data", "cards.json")
FX = os.path.join(ROOT, "data", "effects.json")

j = json.load(open(CARDS, encoding="utf-8"))
fx = json.load(open(FX, encoding="utf-8"))

# ---------- 1. 删除天机门人 ----------
before = len(j["birth"])
j["birth"] = [b for b in j["birth"] if b["id"] != "birth_07"]
print(f"身世：{before} → {len(j['birth'])}（已删除 birth_07 天机门人）")
fx["birth"].pop("birth_07", None)
print("effects.json 已移除 birth_07")

# ---------- 2. 新增神通牌「窥天」 ----------
if not any(d["id"] == "dao_32" for d in j["dao"]):
    j["dao"].append({
        "id": "dao_32",
        "category": "神通牌",
        "name": "窥天",
        "copies": 3,
        "text": "本回合打出后挂起：下一次天机到来、正式执行前，你可以把这道天机对某人的结算效果嫁接到另一人身上"
               "（好事可以嫁接到自己身上，坏事可以把落在自己身上的嫁接走）",
        "target": "天机结算目标（嫁接时需指定「原目标」与「新目标」）",
        "duration": "挂起，跨回合保留至下一次天机执行前；一旦使用即消耗",
        "note": "第五档（本回合施展、后续回合生效）。天机执行前先走窥天者的嫁接选择，再执行被改过的结算。",
    })
    print("道牌：新增 dao_32 窥天")

# ---------- 3. 天命轮转改为「下一回合必定天机动荡」 ----------
for d in j["dao"]:
    if d["id"] == "dao_30":
        d["text"] = "下一回合必定天机动荡：抽取 1 张天机牌并生效（跳过概率判定）"
        d["target"] = "全场"
        d["duration"] = "下一回合天机判定时生效"
        d["note"] = "第五档（本回合施展、后续回合生效）。不再立即抽牌——立即抽牌会在无人可选的回合开始时静默生效，改为延迟一回合后可被看见、可被窥天嫁接。"
        print("道牌：dao_30 天命轮转已改写")

# ---------- 4. 官宦子弟文案：每局开局 ----------
for b in j["birth"]:
    if b["id"] == "birth_03":
        b["effect"] = "第一 / 二 / 三局开局时，从本局正在争夺的术集中随机获取 1 个术系临时使用（不占 3 套上限；本局无争夺术集则跳过）"
        b["note"] = "开局特别阶段：其他人同步等待，并公开提示这是官宦子弟的特权。原文案写成「每回合」，实为每局一次。"
        print("身世：birth_03 官宦子弟文案已修正")

json.dump(j, open(CARDS, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
json.dump(fx, open(FX, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

total = sum(d.get("copies", 1) for d in j["dao"])
print(f"\n道牌：{len(j['dao'])} 种 / 共 {total} 张　身世：{len(j['birth'])} 种")
