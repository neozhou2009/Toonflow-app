/**
 * 分组折叠态的「内容摘要」纯函数。
 * ---------------------------------------------------------------------------
 * 独立成文件的原因：
 *   1. groupNode.vue 依赖 vue-flow 运行时，无法在 node 里直接跑；
 *   2. 摘要逻辑本身是纯的，抽出来才能被 dev-tools/test-group-collapse.mjs 直接测；
 *   3. 折叠后只剩一条标题栏，摘要负责回答「这组是干什么的」。
 *
 * 设计约束（重要）：**绝不覆盖用户命名**。标签还是默认值时展示摘要，
 * 用户一旦自己命名就信他的——那个名本身就是他自己写的摘要。
 */

/** 摘要里展示的节点类型名与顺序，先特例后兜底。 */
export const SUMMARY_TYPES: [match: (node: SummaryNode) => boolean, label: string][] = [
  [node => node.type === "canvasGroup", "分组"],
  [node => !!node.type?.includes("text"), "文本"],
  [node => !!node.type?.includes("image"), "图片"],
  [node => !!node.type?.includes("video"), "视频"],
  [node => !!node.type?.includes("audio"), "音频"],
];

/**
 * 兜底标记：是否有没有命中上面任何一类的节点。
 * ACT: 不能把兜底也做成一条 `!!node.type` 的匹配器——那会让每个节点都被数两遍，
 *      摘要出现「文本×1 图片×1 视频×1 节点×3」这种重复计数。
 *      改为只在没有任何已知类型命中时，用总数兜底。
 */
export const FALLBACK_LABEL = "节点";

/** 建组时写入的默认标签名。用于判定「用户有没有自己命名」。 */
export const DEFAULT_GROUP_LABEL = "分组";

/** 摘要中文本片段的最大长度，避免标题栏被撑爆。 */
export const SUMMARY_EXCERPT_LIMIT = 24;

export interface SummaryNode {
  id: string;
  type?: string;
  data?: Record<string, unknown> & { label?: string };
}

/** 从节点里取一句能代表内容的文字：优先正文，再退回节点名。 */
export function extractText(node: SummaryNode): string {
  const data = node.data ?? {};
  for (const key of ["prompt", "text", "content", "label"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return typeof data.label === "string" ? data.label : "";
}

/** 取第一段有意义的长文本，压成单行。 */
export function firstLine(text: string): string {
  return text.split("\n").map(line => line.trim()).find(Boolean) ?? "";
}

/** 「文本×1 图片×2 视频×1」这类类型计数。 */
export function countTypes(children: SummaryNode[]): string {
  const counts: string[] = [];
  for (const [match, label] of SUMMARY_TYPES) {
    const count = children.filter(match).length;
    if (count > 0) counts.push(`${label}×${count}`);
  }
  // ACT: 一个都没命中时用总数兜底；不要在常规匹配器里放兜底，否则会重复计数。
  if (!counts.length) return `${children.length} ${FALLBACK_LABEL}`;
  return counts.join(" ");
}

/** 首条文本片段：优先没被类型计数覆盖的节点，其次文本节点。 */
export function excerptOf(children: SummaryNode[]): string {
  const counted = new Set(SUMMARY_TYPES.flatMap(([match]) => children.filter(match).map(node => node.id)));
  const textNode = children.find(node => !counted.has(node.id) || !!node.type?.includes("text"));
  if (!textNode) return "";
  return firstLine(extractText(textNode)).slice(0, SUMMARY_EXCERPT_LIMIT);
}

/** 完整摘要：「片段 · 计数」；取不到片段时只给计数。 */
export function summarize(children: SummaryNode[]): string {
  if (!children.length) return "";
  return [excerptOf(children), countTypes(children)].filter(Boolean).join(" · ");
}

/** 标签是否还是默认值（没被用户命名过）。 */
export function isDefaultLabel(label: string | undefined): boolean {
  const named = (label ?? "").trim();
  return !named || named === DEFAULT_GROUP_LABEL;
}

/**
 * 标题最终显示什么。
 * ACT: 展开态永远用原名——摘要只是折叠时的补充展示，绝不改动用户输入。
 *      折叠态：
 *      · 未命名 → 纯摘要；
 *      · 用户命名过 → 「名字 · 摘要」（概要紧跟其后，名字始终在最前）；
 *      · 空分组 → 原名退回「分组」，不拼接空摘要。
 */
export function displayLabel(label: string | undefined, collapsed: boolean, children: SummaryNode[]): string {
  const named = (label ?? "").trim();
  if (!collapsed) return named || DEFAULT_GROUP_LABEL;
  const summary = summarize(children);
  if (!summary) return named || DEFAULT_GROUP_LABEL;
  return isDefaultLabel(named) ? summary : `${named} · ${summary}`;
}
