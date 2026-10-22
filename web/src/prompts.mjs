// prompt 系统：结算中途需要玩家做选择时，向"答案表"要一个答案。
//
// 设计要点（与线上服务端约定）：
//   - 引擎是纯函数，不阻塞、不回调。所有答案在调用 resolveTurn 之前就以 {seat: {promptId: value}} 形式给齐。
//   - 缺答案时走兜底（R18：取最保守选项），保证任何状况下都能算完。
//   - 线上做法：揭示后服务端再发一次"补充选择"（短倒计时），收集完再调 resolveTurn。
//     离线自对弈：AI 在决策时一次性预填。
//
// 五种提示类型正好覆盖全部"二次互动"的牌：
//   target   选目标        （符咒 / 借刀杀人 / 窃取 / 铁索连环 …）
//   card     选牌          （明镜 / 水中捞月 / 镜花水月 / 偷天换日 …）
//   allocate 分配数值      （太极开天门 / 匠作之家）
//   branch   二选一分支    （锁灵符 / 移魂术 / 替罪 …）
//   subgame  同时博弈      （囚徒 / 收割 / 狭路相逢 / 押注）

// target = 选一个目标；targets = 选多个目标（铁索连环 / 移魂术 / 借刀）—— 是 target 的多选变体
export const PROMPT_TYPES = ["target", "targets", "card", "allocate", "branch", "subgame"];

let seq = 0;
export function makePrompt(type, payload) {
  if (!PROMPT_TYPES.includes(type)) throw new Error("未知提示类型: " + type);
  return { id: payload.id || `${type}_${seq++}`, type, ...payload };
}

const isEnemy = (m, actor, q) => q.alive && q.factionId !== actor.factionId;

export function defaultAnswer(m, actor, spec, ctx = {}) {
  switch (spec.type) {
    case "target": {
      const pool = spec.pool || m.players.filter((q) => isEnemy(m, actor, q)).map((q) => q.seat);
      // 默认打血量最低的敌人（最保守的"能拿到击杀"选择）
      const sorted = [...pool].sort((a, b) => m.players[a].hp - m.players[b].hp);
      return sorted[0] ?? null;
    }
    case "targets": {
      const pool = spec.pool || m.players.filter((q) => isEnemy(m, actor, q)).map((q) => q.seat);
      return pool.slice(0, spec.count || 2);
    }
    case "card":
      return spec.pool?.[0] ?? null;
    case "allocate": {
      // 全部转防御：不会误伤、也不会浪费
      const out = { attack: 0, heal: 0, defense: spec.total || 0 };
      return out;
    }
    case "branch": {
      // 赌场兜底也要押一点：全场弃权的话，天机看起来就跟没抽到一样
      if (String(spec.id).startsWith("bet_")) {
        const opts = (spec.options || []).map(Number);
        const up = opts.filter((n) => n > 0);
        return up.length ? Math.min(...up) : (opts[0] ?? 0);
      }
      // 借贷型兜底选 0（不借），最保守
      return spec.options?.[0] ?? null;
    }
    case "subgame": {
      // 保守博弈策略：囚徒认罪、收割跟多数、狭路让
      return spec.default ?? spec.options?.[0] ?? null;
    }
    default:
      return null;
  }
}

// 取答案：优先用调用方给的，其次数据里的 answers，最后兜底
export function ask(ctx, seat, spec) {
  // 联机用：把"本回合需要问谁、问什么"记录下来。
  // 服务端先干跑一次拿到清单，向玩家收答案后再真跑 —— 两次的 id 必须一致。
  if (ctx.prompts) {
    const d = describePrompt(spec);
    if (!ctx.prompts.some((x) => x.id === d.id && x.seat === seat)) ctx.prompts.push({ seat, ...d });
  }

  const given = ctx.answers?.[seat]?.[spec.id];
  if (given !== undefined && given !== null) return given;
  if (spec.type === "target" && spec.pool && !spec.pool.includes(given)) {
    // 非法目标 -> 兜底
  }
  return defaultAnswer(ctx.m, ctx.m.players[seat], spec, ctx);
}

// 生成"本回合需要哪些提示"，供线上在揭示后统一发起追问
export function describePrompt(spec) {
  return { id: spec.id, type: spec.type, label: spec.label || "", options: spec.options || null,
    pool: spec.pool || null, count: spec.count || 1, total: spec.total ?? null };
}
