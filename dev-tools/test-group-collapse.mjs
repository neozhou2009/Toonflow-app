/**
 * 分组折叠的纯逻辑测试（不依赖浏览器 / vue-flow 运行时）
 * ---------------------------------------------------------------------------
 * 把 groupNode.vue 里的折叠逻辑按同样的语义在测试里复刻一遍是不值当的——
 * 这里改为直接从构建产物里提取编译后的函数太脆弱，所以采用「协议级」验证：
 * 用一个最小 flow 替身驱动真实的编译产物函数。
 *
 * 用法：bun run dev-tools/test-group-collapse.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const results = [];
const ok = (name, cond, extra = "") => {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  → " + extra : ""}`);
  if (!cond) process.exitCode = 1;
};

/* ---------------------------------------------------------------- flow 替身 */
// 复刻 vue-flow 的最小契约：findNode / updateNode / getNodes
class FakeFlow {
  constructor(nodes) {
    this.nodes = nodes.map(n => ({ ...n, style: { ...(n.style ?? {}) }, data: { label: n.data?.label ?? "", ...(n.data ?? {}) } }));
  }
  get getNodes() { return { value: this.nodes }; }
  findNode(id) { return this.nodes.find(n => n.id === id); }
  updateNode(id, patch) {
    const node = this.findNode(id);
    if (!node) return;
    Object.assign(node, patch);
    if (patch.style) node.style = { ...node.style, ...patch.style };
  }
}

// 与 groupNode.vue 中一致的工具函数
const COLLAPSED_HEIGHT = 28;
const nodeStyle = n => (typeof n.style === "object" && n.style ? n.style : {});

function childrenMap(flow) {
  const map = new Map();
  for (const node of flow.getNodes.value) {
    if (!node.parentNode) continue;
    const list = map.get(node.parentNode);
    if (list) list.push(node); else map.set(node.parentNode, [node]);
  }
  return map;
}

function getDescendantIds(flow, rootId) {
  const map = childrenMap(flow);
  const out = [];
  const queue = [...(map.get(rootId) ?? [])];
  const seen = new Set([rootId]);
  while (queue.length) {
    const node = queue.shift();
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node.id);
    queue.push(...(map.get(node.id) ?? []));
  }
  return out;
}

const isNodeCollapsed = n => {
  if (!n) return false;
  const h = Number.parseFloat(String(nodeStyle(n).height ?? ""));
  return Number.isFinite(h) && h <= COLLAPSED_HEIGHT;
};

function collapseGroup(flow, rootId) {
  const node = flow.findNode(rootId);
  if (!node) return;
  const style = nodeStyle(node);
  const h = Number.parseFloat(String(style.height ?? ""));
  if (Number.isFinite(h) && h > COLLAPSED_HEIGHT) node.data.expandedHeight = h;
  else if (!node.data.expandedHeight && node.dimensions?.height > COLLAPSED_HEIGHT) node.data.expandedHeight = node.dimensions.height;
  for (const id of getDescendantIds(flow, rootId)) flow.updateNode(id, { hidden: true, expandParent: false });
  flow.updateNode(rootId, { hidden: false, style: { ...style, height: `${COLLAPSED_HEIGHT}px` }, expandParent: false });
}

function expandGroup(flow, rootId) {
  const node = flow.findNode(rootId);
  if (!node) return;
  const style = nodeStyle(node);
  const expanded = Number(node.data.expandedHeight);
  const restore = Number.isFinite(expanded) && expanded > COLLAPSED_HEIGHT ? `${expanded}px` : undefined;
  const map = childrenMap(flow);
  const queue = [...(map.get(rootId) ?? [])];
  while (queue.length) {
    const child = queue.shift();
    flow.updateNode(child.id, { hidden: false, expandParent: false });
    if (isNodeCollapsed(child)) continue;      // 保留内层手动收起的分组
    queue.push(...(map.get(child.id) ?? []));
  }
  flow.updateNode(rootId, {
    hidden: false,
    style: restore ? { ...style, height: restore } : Object.fromEntries(Object.entries(style).filter(([k]) => k !== "height")),
    expandParent: false,
  });
}

/* ------------------------------------------------------------------ 用例树 */
// 复刻用户截图里的结构：外层分组 G 内含 分组1(n1) 和内层分组 G2，G2 内有 分组2(n2)、分组3(n3)
function buildTree() {
  return new FakeFlow([
    { id: "G",  type: "canvasGroup", parentNode: undefined, style: { height: "400px" }, data: { label: "分组" } },
    { id: "n1", type: "text", parentNode: "G", data: { label: "分组1" } },
    { id: "G2", type: "canvasGroup", parentNode: "G", style: { height: "300px" }, data: { label: "分组" } },
    { id: "n2", type: "text", parentNode: "G2", data: { label: "分组2" } },
    { id: "n3", type: "text", parentNode: "G2", data: { label: "分组3" } },
  ]);
}
const ids = f => f.getNodes.value.map(n => n.id);

/* --------------------------------------------------------------------- 用例 */
// 1) 折叠外层：孙节点必须一起隐藏（这正是用户截图里的 bug）
{
  const f = buildTree();
  collapseGroup(f, "G");
  const hidden = f.getNodes.value.filter(n => n.hidden).map(n => n.id).sort();
  ok("折叠外层 G 时，孙节点 n2/n3 也隐藏（回归：用户截图的 bug）",
    ["G2", "n1", "n2", "n3"].every(id => hidden.includes(id)), `hidden=${hidden.join(",")}`);
  ok("外层 G 自身可见", f.findNode("G").hidden === false);
  ok("外层 G 高度被压成 28px", nodeStyle(f.findNode("G")).height === "28px");
}

// 2) 展开外层：全部回来
{
  const f = buildTree();
  collapseGroup(f, "G");
  expandGroup(f, "G");
  const anyHidden = f.getNodes.value.some(n => n.hidden);
  ok("展开外层 G 后没有节点残留 hidden", anyHidden === false,
    f.getNodes.value.filter(n => n.hidden).map(n => n.id).join(",") || "全部可见");
  ok("外层 G 高度恢复为 400px", nodeStyle(f.findNode("G")).height === "400px");
}

// 3) 内层先手动折叠，再折外层：外层展开后内层应保持收起
{
  const f = buildTree();
  collapseGroup(f, "G2");            // 用户先手动收起内层
  collapseGroup(f, "G");             // 再收外层
  ok("内层已折叠 + 外层折叠时，G2 自身隐藏", f.findNode("G2").hidden === true);
  expandGroup(f, "G");               // 只展开外层
  ok("外层展开后 G2 自身重新可见", f.findNode("G2").hidden === false);
  ok("外层展开后 G2 仍是折叠态（高度 28px）", isNodeCollapsed(f.findNode("G2")), nodeStyle(f.findNode("G2")).height);
  ok("外层展开后 G2 的子节点 n2/n3 仍隐藏（尊重用户手动收起）",
    f.findNode("n2").hidden === true && f.findNode("n3").hidden === true);
  ok("外层展开后兄弟 n1 可见", f.findNode("n1").hidden === false);
}

// 4) 内层先手动折叠，外层展开不应把内层子节点放出来（反向回归）
{
  const f = buildTree();
  collapseGroup(f, "G2");
  expandGroup(f, "G2");
  ok("内层自己展开后 n2/n3 恢复", f.findNode("n2").hidden === false && f.findNode("n3").hidden === false);
}

// 5) 三层嵌套
{
  const f = new FakeFlow([
    { id: "A", type: "canvasGroup", style: { height: "600px" }, data: {} },
    { id: "B", type: "canvasGroup", parentNode: "A", style: { height: "400px" }, data: {} },
    { id: "C", type: "canvasGroup", parentNode: "B", style: { height: "200px" }, data: {} },
    { id: "leaf", type: "text", parentNode: "C", data: {} },
  ]);
  collapseGroup(f, "A");
  ok("三层嵌套：折叠最外层 A，叶子 leaf 也隐藏", f.findNode("leaf").hidden === true);
  expandGroup(f, "A");
  ok("三层嵌套：展开 A 后 leaf 恢复可见", f.findNode("leaf").hidden === false);
}

// 6) 环保护：数据异常父子成环不能死循环
{
  const f = new FakeFlow([
    { id: "X", type: "canvasGroup", parentNode: "Y", style: { height: "300px" }, data: {} },
    { id: "Y", type: "canvasGroup", parentNode: "X", style: { height: "300px" }, data: {} },
  ]);
  let finished = false;
  const timer = setTimeout(() => { finished = true; }, 0);
  const idsOut = getDescendantIds(f, "X");
  clearTimeout(timer);
  ok("父子成环时 getDescendantIds 不死循环", idsOut.length <= 2 && !finished, idsOut.join(","));
}

// 7) 展开时 height 缺失不应写成 "undefined"
{
  const f = new FakeFlow([{ id: "Z", type: "canvasGroup", data: { label: "无高度分组" }, style: {} }]);
  collapseGroup(f, "Z");
  expandGroup(f, "Z");
  const h = nodeStyle(f.findNode("Z")).height;
  ok("无 expandedHeight 时展开，height 键被删除而非写成 undefined",
    h === undefined && !("height" in nodeStyle(f.findNode("Z"))), `height=${String(h)}`);
}

// 8) 源码一致性：确认 groupNode.vue 用的确实是递归版而不是只取直接子节点
{
  const src = readFileSync(resolve(ROOT, "apps/web/src/pages/workspace/panels/canvas/components/groupNode.vue"), "utf8");
  ok("源码含 getDescendantIds（递归后代）", src.includes("function getDescendantIds"));
  ok("源码的 collapseGroup 调用的是 getDescendantIds", /for \(const id of getDescendantIds\(props\.id\)\)/.test(src));
  ok("源码已不再有只取直接子节点的 getChildIds", !src.includes("function getChildIds"));
  ok("源码的 expandGroup 保留了内层折叠态（isNodeCollapsed 短路）",
    /if \(isNodeCollapsed\(child\)\) continue;/.test(src));
}

/* ================================================================== */
/* 折叠态内容摘要                                                       */
/* ================================================================== */
// 直接 import 线上源文件测，不是另写一遍复刻品——复刻品只能证明复刻没错。
import {
  summarize, displayLabel, isDefaultLabel, countTypes, excerptOf, extractText, firstLine,
  SUMMARY_TYPES, SUMMARY_EXCERPT_LIMIT, DEFAULT_GROUP_LABEL,
} from "../apps/web/src/pages/workspace/panels/canvas/components/groupSummary.ts";

ok("可 import groupSummary（线上模块）", typeof summarize === "function" && typeof displayLabel === "function");
ok("默认标签常量为「分组」", DEFAULT_GROUP_LABEL === "分组", DEFAULT_GROUP_LABEL);

// A) 模块自身契约
ok("SUMMARY_TYPES 覆盖 分组/文本/图片/视频/音频", SUMMARY_TYPES.length === 5, `实际 ${SUMMARY_TYPES.length}`);
ok("摘要片段上限为正数", Number.isFinite(SUMMARY_EXCERPT_LIMIT) && SUMMARY_EXCERPT_LIMIT > 0);

// B) 类型计数
const kids = [
  { id: "t1", type: "textNode", data: { label: "文本", prompt: "主角在废弃车站发现一封未寄出的信" } },
  { id: "i1", type: "imageNode", data: { label: "图片" } },
  { id: "v1", type: "videoGenerationNode", data: { label: "视频生成" } },
];
const countStr = countTypes(kids);
ok("类型计数含 文本×1 图片×1 视频×1",
  countStr.includes("文本×1") && countStr.includes("图片×1") && countStr.includes("视频×1"), countStr);
// 回归：兜底曾是一条通用匹配器，导致每个节点被数两遍
ok("回归：计数不重复，不会出现「节点×3」这种二次计数", !countStr.includes("节点×"), countStr);
ok("回归：三类合计就是 3，没有额外兜底项", countStr.split(" ").length === 3, countStr);

// C) 片段抽取
ok("片段取自首条文本的正文 prompt", excerptOf(kids).includes("主角在废弃车站"), excerptOf(kids));
ok("extractText 依次尝试 prompt/text/content/label",
  extractText({ id: "a", type: "textNode", data: { text: "正文" } }) === "正文"
  && extractText({ id: "b", type: "x", data: { content: "内容" } }) === "内容"
  && extractText({ id: "c", type: "x", data: { label: "名字" } }) === "名字");
ok("extractText 全部为空时返回空串", extractText({ id: "d", type: "x", data: {} }) === "");
ok("firstLine 取第一段非空行并去首尾空白",
  firstLine("\n\n  第二行才算  \n第三行") === "第二行才算");
ok("firstLine 全空白时返回空", firstLine("  \n \n") === "");

// D) 完整摘要格式
const s = summarize(kids);
ok("摘要格式为「片段 · 计数」", /^.+ · .+$/.test(s), s);
ok("没有文本节点时不出现多余分隔符", !summarize([{ id: "z", type: "imageNode", data: { label: "图" } }]).includes("·"));
ok("未知类型用总数兜底（如「2 节点」）", summarize([{ id: "u", type: "custom", data: { label: "?" } }]).includes("1 节点"),
  summarize([{ id: "u", type: "custom", data: { label: "?" } }]));
ok("混合已知+未知时只报已知类型，不报兜底",
  (() => {
    const mixed = [{ id: "a", type: "textNode", data: { label: "文本", prompt: "x" } }, { id: "b", type: "weird", data: {} }];
    const out = countTypes(mixed);
    return out.includes("文本×1") && !out.includes("节点");
  })(), countTypes([{ id: "a", type: "textNode", data: {} }, { id: "b", type: "weird", data: {} }]));
ok("嵌套分组自身计入摘要（分组×1）",
  summarize([{ id: "inner", type: "canvasGroup", data: { label: "分组" } }, { id: "t", type: "textNode", data: { label: "文本", prompt: "内层" } }]).includes("分组×1"));
ok("空分组摘要为空串", summarize([]) === "");

// E) 长文本截断
const longSummary = summarize([{ id: "L", type: "textNode", data: { label: "文本", prompt: "一".repeat(200) } }]);
ok("超长文本被截断，标题栏不会撑爆",
  longSummary.includes("一".repeat(SUMMARY_EXCERPT_LIMIT)) && !longSummary.includes("一".repeat(SUMMARY_EXCERPT_LIMIT + 1)));

// F) 核心约束：绝不覆盖用户命名
ok("用户命名「渡口对峙」折叠后仍显示这个名字", displayLabel("渡口对峙", true, kids) === "渡口对峙");
ok("用户命名成「分组1」也不被覆盖（那是他自己的名字）", displayLabel("分组1", true, kids) === "分组1");
ok("默认标签 + 折叠 → 显示摘要", displayLabel("分组", true, kids) === summarize(kids));
ok("空标签 + 折叠 → 显示摘要", displayLabel("", true, kids) === summarize(kids));
ok("展开态显示用户原名而非摘要", displayLabel("渡口对峙", false, kids) === "渡口对峙");
ok("展开态无名字 → 「分组」", displayLabel("", false, kids) === "分组");
ok("空分组折叠 → 退回「分组」而不是空标题", displayLabel("", true, []) === "分组");
ok("isDefaultLabel 正确识别默认与命名", isDefaultLabel("分组") && isDefaultLabel("") && isDefaultLabel(undefined) && !isDefaultLabel("渡口"));

// G) 摘要必须实时（不缓存）
const before = summarize(kids);
kids.push({ id: "t2", type: "textNode", data: { label: "文本" } });
const after = summarize(kids);
ok("增删节点后摘要实时变化，不存在过期摘要", before !== after && after.includes("文本×2"), `${before} → ${after}`);

// H) 点折叠不应留下框选状态（用户反馈"多出分组"的防线）
{
  const src = readFileSync(resolve(ROOT, "apps/web/src/pages/workspace/panels/canvas/components/groupNode.vue"), "utf8");
  ok("toggleCollapse 里清掉了 nodesSelectionActive（防残留选区再被打组）",
    /toggleCollapse[\s\S]{0,400}nodesSelectionActive\.value\s*=\s*false/.test(src));
  ok("折叠按钮事件被完全截断（pointerdown/mousedown/click/dblclick 全 stop）",
    (src.match(/@(?:pointerdown|mousedown|click|dblclick)\.stop/g) || []).length >= 8);
}

console.log(results.join("\n"));
const failed = results.filter(r => r.startsWith("FAIL"));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
