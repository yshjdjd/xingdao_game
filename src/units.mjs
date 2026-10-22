// 定点数：1 单位 = 0.5 点。血量、能量、数值全部用整数存，禁止浮点比较。
// 依据 R20 / 规则书 2.2「涉及 0.5 的加减精确计算，不做四舍五入」。
export const U = 0.5;
export const toU = (v) => Math.round(v / U);        // 3 点 -> 6U
export const fromU = (u) => u * U;                  // 6U -> 3
export const fmt = (u) => {
  const v = u * U;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};
export const INF = Number.POSITIVE_INFINITY;
