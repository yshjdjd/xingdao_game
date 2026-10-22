# -*- coding: utf-8 -*-
"""给道牌加「生效顺序 order」（R46 定稿），并落地三张牌的效果修订（R57）。

order 规则：
  - 允许小数；整数部分 = 档位（1–6），小数部分 = 档内顺序；数值越小越优先。
  - 1.x  对所出牌本身的影响（溯流光 / 锁灵符 / 偷天换日）
  - 2.x  能量与血量的直接变化（回春 / 献祭）
  - 3.x  对本次出牌的数值影响（护心镜 / 赤霄剑 / 罡风靴 / 紫气玉佩 / 引雷 / 破防 / 倍蓄）
  - —— 判定与扣血在此之间 ——
  - 4.x  判定后触发的效果（聚灵玉环 / 洞玄冠 / 泣血珠 / 逆鳞金甲 …… 替罪 4.9 压档尾）
  - 5.x  需另开博弈画面的神策牌（收割 / 移魂术 / 囚徒 / 狭路相逢）
  - 6.x  本回合施展、后续回合生效（往生咒 …… 铁索连环 6.91）
  - 被动：替身玉符、无懈可击，order = null（持有即生效，不占档位）
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARDS = os.path.join(ROOT, "data", "cards.json")

ORDER = {
    "dao_33": 1.1,    # 溯流光（新增）
    "dao_15": 1.2,    # 锁灵符
    "dao_18": 1.3,    # 偷天换日
    "dao_21": 2.1,    # 回春
    "dao_25": 2.2,    # 献祭
    "dao_01": 3.1,    # 太虚护心镜
    "dao_02": 3.2,    # 赤霄剑
    "dao_03": 3.3,    # 罡风靴
    "dao_08": 3.4,    # 紫气玉佩
    "dao_22": 3.5,    # 引雷
    "dao_23": 3.6,    # 破防
    "dao_24": 3.7,    # 倍蓄
    "dao_04": 4.1,    # 聚灵玉环
    "dao_07": 4.2,    # 洞玄冠
    "dao_09": 4.3,    # 泣血珠
    "dao_05": 4.4,    # 逆鳞金甲
    "dao_26": 4.9,    # 替罪（本档最后）
    "dao_19": 5.1,    # 收割
    "dao_16": 5.2,    # 移魂术
    "dao_12": 5.3,    # 囚徒
    "dao_17": 5.4,    # 狭路相逢
    "dao_29": 6.1,    # 往生咒
    "dao_27": 6.2,    # 窃取
    "dao_13": 6.3,    # 借刀杀人
    "dao_28": 6.4,    # 焚术
    "dao_10": 6.5,    # 终焉之奏
    "dao_20": 6.6,    # 天下大白
    "dao_32": 6.7,    # 窥天
    "dao_30": 6.8,    # 天命轮转
    "dao_14": 6.9,    # 枪打出头鸟
    "dao_11": 6.91,   # 铁索连环
    "dao_06": None,   # 替身玉符（被动）
    "dao_31": None,   # 无懈可击（被动）
}

TIER_NAME = {
    1: "① 对所出牌本身的影响",
    2: "② 能量与血量的直接变化",
    3: "③ 对本次出牌的数值影响",
    4: "④ 判定后触发的效果",
    5: "⑤ 需另开博弈画面的神策牌",
    6: "⑥ 本回合施展、后续回合生效",
}

j = json.load(open(CARDS, encoding="utf-8"))

# ---------- 新增神策牌「溯流光」 ----------
if not any(d["id"] == "dao_33" for d in j["dao"]):
    j["dao"].append({
        "id": "dao_33",
        "category": "神策牌",
        "name": "溯流光",
        "copies": 2,
        "text": "打出本道牌后，在所有人出牌结束并揭示之后，你可以重新出一次牌"
               "（可以是别的术 + 别的道牌，也可以干脆不出），但重新出牌消耗的能量"
               "必须 ≤ 你一开始出那张术所消耗的能量",
        "target": "自身",
        "duration": "本回合揭示后触发一次",
        "note": "第 1 档 1.1：它改的是\"这一手牌是什么\"，所以必须排在所有效果之前。"
                "重出时不得借机升档——能量上限锁死在首出那张术的消耗上。",
    })
    print("道牌：新增 dao_33 溯流光（神策牌 ×2）")

# ---------- 效果修订：太虚护心镜 / 倍蓄 ----------
for d in j["dao"]:
    if d["id"] == "dao_01":
        d["text"] = "你的防御数值 +0.5"
        d["note"] = "R57 改版：原为「你受到的攻击数值 −0.5」，改成直接加防御数值。"
        print("道牌：dao_01 太虚护心镜 → 防御数值 +0.5")
    if d["id"] == "dao_24":
        d["text"] = "本回合蓄力效果 ×3；若未蓄力则改为获得 1 能量；但若蓄力时被命中，则本回合一点能量都拿不到"
        d["note"] = "R57 改版：原写法让\"蓄力被打断\"仍有保底，现在明确——蓄力受伤害 = 本回合颗粒无收。"
        print("道牌：dao_24 倍蓄 文案已改")

# ---------- 写 order / tier ----------
miss = []
for d in j["dao"]:
    o = ORDER.get(d["id"])
    if o is None and d["id"] not in ("dao_06", "dao_31"):
        miss.append(d["id"])
    d["order"] = o
    d["tier"] = None if o is None else TIER_NAME[int(o)]
    if o is None:
        d["duration"] = "持有即生效（被动触发）"
        d["note"] = (d.get("note", "") + "　不占档位：只要还在手上就可能被触发。").strip()

if miss:
    print("!! 未指定顺序的道牌：", miss)

# 按 order 排序（被动的排最后），让表格读起来就是执行顺序
j["dao"].sort(key=lambda d: (d["order"] is None, d["order"] if d["order"] is not None else 0))

json.dump(j, open(CARDS, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

total = sum(d.get("copies", 1) for d in j["dao"])
print(f"\n道牌：{len(j['dao'])} 种 / 共 {total} 张")
for d in j["dao"]:
    print(f"  {str(d['order']) if d['order'] is not None else '被动':>6}  {d['category']:<4} {d['name']}")
