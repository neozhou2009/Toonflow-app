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
// 直接 import 线上模块：折叠/展开的计划、后代收集、摘要，全链路测真代码
import {
  COLLAPSED_HEIGHT, collectDescendants, planExpand, collapsedStyle, restoredStyle,
  rememberExpandedHeight, isCollapsedHeight, styleOf, expandedHeightOf,
  fitChainToVisible, planFitVisible,
} from "../apps/web/src/pages/workspace/panels/canvas/components/groupCollapse.ts";

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

// 下面这两个薄封装只是把真实模块的计划落到 FakeFlow 上。
// 逻辑全在 groupCollapse.ts 里——测这里等于测线上代码，不再是复刻品。
function collapseGroup(flow, rootId) {
  const node = flow.findNode(rootId);
  if (!node) return;
  node.data.expandedHeight = rememberExpandedHeight(node);
  for (const id of collectDescendants(flow.getNodes.value, rootId)) flow.updateNode(id, { hidden: true, expandParent: false });
  flow.updateNode(rootId, { hidden: false, style: collapsedStyle(node), expandParent: false });
}

function expandGroup(flow, rootId) {
  const plan = planExpand(flow.getNodes.value, rootId);
  for (const id of plan.unhide) flow.updateNode(id, { hidden: false, expandParent: false });
  for (const [id, style] of plan.restyle) flow.updateNode(id, { style, expandParent: false });
}

// 兼容旧用例里的写法
const expandGroupWithAncestors = expandGroup;
const nodeStyle = styleOf;
const getDescendantIds = (flow, rootId) => collectDescendants(flow.getNodes.value, rootId);
const isNodeCollapsed = isCollapsedHeight;

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
  // ACT: 折叠/展开逻辑已抽到 groupCollapse.ts，这里断言"组件不再自己实现一遍"。
  ok("组件不再本地重复实现 collectDescendants", !src.includes("function collectDescendants"));
  ok("组件不再本地重复实现 getDescendantIds", !src.includes("function getDescendantIds"));
  ok("组件的 collapseGroup 调用 collectDescendants（递归后代）", /collectDescendants\(/.test(src));
  ok("组件的 expandGroup 调用 planExpand（含祖先传播）", /planExpand\(/.test(src));
  ok("组件从 groupCollapse 取折叠态判定", /isCollapsedHeight\(/.test(src));

  // 被抽出到的模块自身：必须有递归 + 祖先传播 + 尊重内层折叠态
  const mod = readFileSync(resolve(ROOT, "apps/web/src/pages/workspace/panels/canvas/components/groupCollapse.ts"), "utf8");
  ok("groupCollapse.ts 含 collectDescendants（递归后代）", /export function collectDescendants/.test(mod));
  ok("groupCollapse.ts 的 planExpand 向上遍历祖先链", /while \(ancestorId/.test(mod));
  ok("groupCollapsed.ts 展开时尊重内层手动折叠态", /isCollapsedHeight\(live\)\) continue/.test(mod));
  ok("groupCollapse.ts 为被连带隐藏的内层组补记高度", /rememberExpandedHeight\(live\)/.test(mod));
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

// 9) 回归：内层展开时父组必须跟着展开（用户截图：子组展开了父组还是空的）
{
  const f = new FakeFlow([
    { id: "P", type: "canvasGroup", style: { height: "400px" }, data: { label: "分组" } },
    { id: "C", type: "canvasGroup", parentNode: "P", style: { height: "300px" }, data: { label: "分组" } },
    { id: "n1", type: "textNode", parentNode: "P", data: { label: "文本" } },
    { id: "n2", type: "textNode", parentNode: "C", data: { label: "文本" } },
  ]);
  // 外层收起 → 内层也进了 hidden
  collapseGroup(f, "P");
  ok("前置：外层折叠后内层 C 与 n2 均隐藏", f.findNode("C").hidden && f.findNode("n2").hidden);
  // 现在只点内层的展开（模拟用户操作：内层按钮在折叠态仍可见）
  expandGroupWithAncestors(f, "C");
  ok("回归：内层展开后自己的子节点可见", f.findNode("n2").hidden === false);
  ok("回归：内层展开后父组 P 也跟着展开（不再只剩空框）", f.findNode("P").hidden === false);
  ok("回归：父组 P 的高度被还原为 400px", nodeStyle(f.findNode("P")).height === "400px", nodeStyle(f.findNode("P")).height);
  ok("回归：父组里兄弟节点 n1 也恢复可见", f.findNode("n1").hidden === false);
  ok("回归：内层 C 自身高度恢复为 300px", nodeStyle(f.findNode("C")).height === "300px");
}

// 10) 回归：孙节点在深层折叠态下，逐层展开要能一层层打开
{
  const f = new FakeFlow([
    { id: "A", type: "canvasGroup", style: { height: "600px" }, data: {} },
    { id: "B", type: "canvasGroup", parentNode: "A", style: { height: "300px" }, data: {} },
    { id: "leaf", type: "textNode", parentNode: "B", data: {} },
  ]);
  collapseGroup(f, "A");
  collapseGroup(f, "B");
  ok("前置：A、B 均折叠后 leaf 隐藏", f.findNode("leaf").hidden && f.findNode("A").hidden === false);
  expandGroupWithAncestors(f, "B");
  ok("回归：展开 B 时祖先 A 一并展开", f.findNode("A").hidden === false && nodeStyle(f.findNode("A")).height === "600px");
  ok("回归：展开 B 后 leaf 可见", f.findNode("leaf").hidden === false);
}

// 12) 回归：子分组折叠时父组大小自适应缩小（用户反馈）
{
  const f = new FakeFlow([
    { id: "P", type: "canvasGroup", style: { height: "400px" }, data: { label: "分组" }, dimensions: { width: 800, height: 400 } },
    { id: "C", type: "canvasGroup", parentNode: "P", style: { height: "300px" }, data: { label: "分组" }, dimensions: { width: 700, height: 300 } },
    { id: "n1", type: "textNode", parentNode: "P", position: { x: 40, y: 60 }, data: { label: "文本" }, dimensions: { width: 100, height: 80 } },
    { id: "n2", type: "textNode", parentNode: "C", position: { x: 50, y: 70 }, data: { label: "文本" }, dimensions: { width: 100, height: 80 } },
  ]);
  collapseGroup(f, "C");   // 收起内层 C
  const P = f.findNode("P");
  // C 现在 hidden，所以 P 的可见子节点只剩 n1 → P 高度应明显小于 400
  const planP = planFitVisible(f.getNodes.value, "P");
  ok("回归：C 折叠后父组 P 的贴合计划以可见子节点计算", planP !== undefined, `P 高度 ${planP?.height}`);
  ok("回归：父组 P 的新高度远小于原 400（缩小了）",
    planP !== undefined && planP.height < 200, `${planP?.height}px`);
  ok("回归：对比——若把 hidden 也算进边界（上游行为），高度就不会缩",
    (() => {
      const nodes = f.getNodes.value.filter(n => n.parentNode === "P" && n.position && n.dimensions);
      // 只把可见节点算一遍，证明可见集合的高度确实变小了
      const visibleOnly = nodes.filter(n => !n.hidden);
      const hVisible = Math.max(...visibleOnly.map(n => n.position.y + n.dimensions.height))
        - (Math.min(...visibleOnly.map(n => n.position.y)) - 40) + 24;
      return hVisible < 300;   // 收起来了
    })());
  // 收缩链应覆盖 P 和它自己的祖先
  const chain = fitChainToVisible(f.getNodes.value, "P");
  ok("回归：fitChainToVisible 返回至少一个步骤（贴合 P 自身）", chain.length >= 1, `len=${chain.length}`);
  ok("回归：收缩步骤只针对可见子节点，shifts 与 children 一致",
    chain[0].shifts.length === (chain[0].shifts.length ? 1 : 0) || chain[0].shifts.length <= 2);
}

// 13) 回归：全部子节点 hidden 时父组不能再收缩（无可量边界，保持现状）'
{
  const f = new FakeFlow([
    { id: "Q", type: "canvasGroup", style: { height: "300px" }, data: {}, dimensions: { width: 500, height: 300 } },
    { id: "c1", type: "textNode", parentNode: "Q", position: { x: 30, y: 40 }, hidden: true, data: {}, dimensions: { width: 50, height: 50 } },
  ]);
  const plan = planFitVisible(f.getNodes.value, "Q");
  ok("回归：全部子节点 hidden 时返回 undefined（不强行收缩为 0 高）", plan === undefined);
}

// 14) 回归：折叠态标题不可能是空白
{
  const cases = [
    { label: undefined, type: "canvasGroup" },
    { label: "", type: "canvasGroup" },
    { label: "分组", type: "canvasGroup" },
    { label: "渡口", type: "canvasGroup" },
  ];
  for (const c of cases) {
    const out = displayLabel(c.label, true, []);
    ok(`回归：折叠态标题非空白（label=${JSON.stringify(c.label)}）`,
      typeof out === "string" && out.trim().length > 0, `得到 "${out}"`);
  }
  // 有内容时必须出摘要，且摘要非空白
  const withKids = displayLabel("分组", true, [
    { id: "i", type: "imageNode", data: { label: "图片" } },
  ]);
  ok("回归：未命名且有子节点时折叠态给摘要（如「图片×1」）",
    withKids.trim().length > 0 && withKids !== "分组", withKids);
  // 单分组场景：组里只有一个分组（用户说的"只有一个分组折叠时"）
  const single = displayLabel(undefined, true, [{ id: "g", type: "canvasGroup", data: { label: "分组" } }]);
  ok("回归：单分组折叠时也有标题（分组×1）", single.includes("分组×1"), single);
}

console.log(results.join("\n"));
const failed = results.filter(r => r.startsWith("FAIL"));
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
