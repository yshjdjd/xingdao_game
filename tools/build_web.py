#!/usr/bin/env python3
"""把引擎打包成可以直接部署到静态托管的 web/ 目录。

产物：
  web/index.html          页面
  web/app.mjs             交互逻辑（直接 import src 下的引擎）
  web/data.bundle.js      cards.json + effects.json 注入 globalThis.__XD_DATA__
  web/src/*.mjs           引擎源码副本（浏览器原生 ESM，无需打包器）

这样"部署"就是把这个目录传上去，不引入 npm / 构建链。
"""
import json
import os
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")


def main():
    os.makedirs(os.path.join(WEB, "src"), exist_ok=True)

    cards = json.load(open(os.path.join(ROOT, "data", "cards.json"), encoding="utf-8"))
    effects = json.load(open(os.path.join(ROOT, "data", "effects.json"), encoding="utf-8"))
    payload = {"cards": cards, "effects": effects}
    with open(os.path.join(WEB, "data.bundle.js"), "w", encoding="utf-8") as f:
        f.write("// 由 tools/build_web.py 生成，勿手改。改数值请改 卡牌.xlsx 后重跑 import_cards.py\n")
        f.write("globalThis.__XD_DATA__ = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    src_dir = os.path.join(ROOT, "src")
    for name in sorted(os.listdir(src_dir)):
        if name.endswith(".mjs"):
            shutil.copyfile(os.path.join(src_dir, name), os.path.join(WEB, "src", name))

    total = 0
    for dirpath, _, files in os.walk(WEB):
        for fn in files:
            total += os.path.getsize(os.path.join(dirpath, fn))
    print("web/ 已生成：%.1f KB（%d 个文件）" % (total / 1024, sum(len(f) for _, _, f in os.walk(WEB))))


if __name__ == "__main__":
    main()
