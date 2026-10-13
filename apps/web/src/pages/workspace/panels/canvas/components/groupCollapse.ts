/**
 * 分组折叠的纯逻辑：祖先展开、后代收集、折叠/展开计划。
 * ---------------------------------------------------------------------------
 * 从 groupNode.vue 抽出来的原因与 groupSummary.ts 相同：这些判定是纯的，
 * 抽出来才能被 dev-tools/test-group-collapse.mjs 直接测，
 * 而不是在测试里另写一遍复刻品——复刻品只能证明复刻没错。
 *
 * 这里只输出「要对哪些节点做什么」的计划，不直接改 flow，
 * 由调用方（groupNode.vue）负责落地到 vue-flow。
 */

export const COLLAPSED_HEIGHT = 28;

export interface CollapseNode {
  id: string;
  parentNode?: string;
  type?: string;
  hidden?: boolean;
  style?: Record<string, unknown>;
  data?: Record<string, unknown> & { expandedHeight?: number };
}

/** 节点的 style 对象，兼容函数式 style。 */
export function styleOf(node: CollapseNode): Record<string, unknown> {
  if (typeof node.style === "function") return (node.style as unknown as (n: CollapseNode) => Record<string, unknown>)(node) ?? {};
  return typeof node.style === "object" && node.style ? node.style : {};
}

/** 高度是否为「折叠态」（被压成标题条）。 */
export function isCollapsedHeight(node: CollapseNode | undefined): boolean {
  if (!node) return false;
  const height = Number.parseFloat(String(styleOf(node).height ?? ""));
  return Number.isFinite(height) && height <= COLLAPSED_HEIGHT;
}

/** 读取节点记忆的展开高度，用于还原。 */
export function expandedHeightOf(node: CollapseNode): number | undefined {
  const value = Number(node.data?.expandedHeight);
  return Number.isFinite(value) && value > COLLAPSED_HEIGHT ? value : undefined;
}

/**
 * 展开时要恢复的 style。
 * ACT: 有记忆高度就还原；没有则**删掉 height 键**而不是写成 undefined，
 *      否则字符串 "undefined" 会让 vue-flow 量不出尺寸，节点挤成一团。
 */
export function restoredStyle(node: CollapseNode): Record<string, unknown> {
  const style = styleOf(node);
  const height = expandedHeightOf(node);
  return height ? { ...style, height: `${height}px` }
    : Object.fromEntries(Object.entries(style).filter(([key]) => key !== "height"));
}

/**
 * 折叠一个分组要隐藏的节点 id（整棵子树，广度优先）。
 * ACT: 必须递归到孙节点——它们的 parentNode 指向内层分组，
 *      只取直接子节点会让「分组里的分组」漏在外面（已见用户截图）。
 *      visited 兜底，防数据异常成环死循环。
 */
export function collectDescendants(nodes: CollapseNode[], rootId: string): string[] {
  const byParent = new Map<string, CollapseNode[]>();
  for (const node of nodes) {
    if (!node.parentNode) continue;
    const list = byParent.get(node.parentNode);
    if (list) list.push(node);
    else byParent.set(node.parentNode, [node]);
  }
  const result: string[] = [];
  const queue = [...(byParent.get(rootId) ?? [])];
  const visited = new Set<string>([rootId]);
  while (queue.length) {
    const node = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    result.push(node.id);
    queue.push(...(byParent.get(node.id) ?? []));
  }
  return result;
}

/**
 * 展开分组时的完整计划：向上解开祖先，向下铺开自己这一支。
 *
 * ACT: 这是修 bug 的关键。原先只向下遍历，从不向上——内层点展开时外层
 *      仍是 hidden，表现为"子组展开了父组还是个空框"。
 *      同时向下那条支里，遇到自身处于折叠态的后代分组要止步，
 *      保留用户手动收起的内层分组；且每次判断都要用实时节点数据，
 *      不能用过期引用（旧引用的 style.height 可能是快照）。
 */
export function planExpand(nodes: CollapseNode[], rootId: string) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const root = byId.get(rootId);
  const unhide = new Set<string>();
  const restyle = new Map<string, Record<string, unknown>>();
  if (!root) return { unhide, restyle, rootId };

  // 1) 向上：祖先链上被折叠的组一并展开，父框里其他子节点也跟着显示。
  let ancestorId = root.parentNode;
  const visitedUp = new Set<string>([rootId]);
  while (ancestorId && !visitedUp.has(ancestorId)) {
    visitedUp.add(ancestorId);
    const ancestor = byId.get(ancestorId);
    if (!ancestor) break;
    if (isCollapsedHeight(ancestor)) {
      restyle.set(ancestorId, restoredStyle(ancestor));
      // 祖先展开了，它的其他子节点也要显示，否则父框里只有当前这一支。
      for (const sibling of nodes) {
        if (sibling.parentNode === ancestorId && sibling.id !== rootId) unhide.add(sibling.id);
      }
    } else if (ancestor.hidden) {
      unhide.add(ancestorId);
    }
    ancestorId = ancestor.parentNode;
  }

  // 2) 向下：铺开自己这一支，遇到自身折叠的后代分组就止步。
  //    ACT: 外层折叠时只是把内层组 hidden 了，并没有压它的高度、也没记它的
  //        expandedHeight。所以这里对"被 hidden 但不是自己收起"的内层组，
  //        补记一次展开高度，否则展开时 restoredStyle 拿不到值会把 height 键删掉，
  //        内层框缩水折叠（表现为"内层展开后高度不对"）。
  const byParent = new Map<string, CollapseNode[]>();
  for (const node of nodes) {
    if (!node.parentNode) continue;
    const list = byParent.get(node.parentNode);
    if (list) list.push(node);
    else byParent.set(node.parentNode, [node]);
  }
  const queue = [...(byParent.get(rootId) ?? [])];
  const visited = new Set<string>([rootId]);
  while (queue.length) {
    const node = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    unhide.add(node.id);
    const live = byId.get(node.id);
    // ACT: hidden 且高度没被压过 → 它是被外层连带隐藏的，补记高度后就可以安全展开。
    if (live && live.hidden && !isCollapsedHeight(live)) {
      const remembered = rememberExpandedHeight(live);
      if (remembered !== undefined) {
        live.data = { ...(live.data ?? {}), expandedHeight: remembered };
        restyle.set(node.id, restoredStyle(live));
      }
    }
    if (isCollapsedHeight(live)) continue;      // 尊重用户手动收起的内层分组
    queue.push(...(byParent.get(node.id) ?? []));
  }

  unhide.add(rootId);
  // ACT: root 自己同样可能只是"被外层连带隐藏"的——外层折叠时不记它的高度，
  //      直接 restoredStyle 会把 height 键删掉，导致内层框缩水。
  //      BFS 从 root 的子节点起步，root 自己不在队列里，所以这里要单独补一次。
  if (root.hidden && !isCollapsedHeight(root)) {
    const remembered = rememberExpandedHeight(root);
    if (remembered !== undefined) {
      root.data = { ...(root.data ?? {}), expandedHeight: remembered };
      restyle.set(rootId, restoredStyle(root));
      return { unhide, restyle, rootId };
    }
  }
  restyle.set(rootId, restoredStyle(root));
  return { unhide, restyle, rootId };
}

/** 折叠分组要写入的 style（压成标题条）。 */
export function collapsedStyle(node: CollapseNode): Record<string, unknown> {
  return { ...styleOf(node), height: `${COLLAPSED_HEIGHT}px` };
}

/**
 * 折叠时把当前高度记忆下来。
 * ACT: 建组时写过 style.height；没写过就退回 dimensions.height，
 *      否则展开后丢掉尺寸，节点会挤在框外。只在拿到更大值时才覆盖。
 */
export function rememberExpandedHeight(node: CollapseNode & { dimensions?: { height?: number } }): number | undefined {
  const styleHeight = Number.parseFloat(String(styleOf(node).height ?? ""));
  const current = Number.isFinite(styleHeight) && styleHeight > COLLAPSED_HEIGHT ? styleHeight
    : node.dimensions?.height && node.dimensions.height > COLLAPSED_HEIGHT ? node.dimensions.height : undefined;
  if (current === undefined) return node.data?.expandedHeight;
  return Math.max(current, node.data?.expandedHeight ?? 0);
}

export interface FitPlanStep {
  groupId: string;
  /** 组的新 position（父坐标）。 */
  position: { x: number; y: number };
  width: number;
  height: number;
  /** 随组平移的可见子节点：[(id, 相对位移)]。 */
  shifts: { id: string; dx: number; dy: number }[];
}

/**
 * 按「可见直系子节点」重新贴合一个组的边界，返回纯计划，由调用方落地。
 *
 * ACT: 上游 fitGroupBounds 不过滤 hidden 子节点——展开场景全部可见没问题，
 *      但折叠场景子节点被隐藏后 dimensions 还是旧值，照它算父框永远缩不小
 *      （用户报的"子分组折叠时父分组大小没有自适应缩小"）。所以这里
 *      只统计 !hidden 的直系子节点，且跳过还没量出尺寸的。
 *      布局公式与上游一致（-24/-40 内边距，右/下 +24 呼吸空间）。
 */
export function planFitVisible(nodes: CollapseNode[], groupId: string): FitPlanStep | undefined {
  const group = nodes.find(node => node.id === groupId);
  if (!group) return undefined;
  // ACT: 只统计「可见且可量」（position + 尺寸齐全）的直系子节点；
  //      没量完（如刚拖进来的新组、隐藏的旧组）直接跳过，而不是整个拒绝贴合——
  //      否则内层组缺个 position 就让父框永远缩不小。
  const children = nodes.filter(node => node.parentNode === groupId && !node.hidden
    && node.position && node.dimensions?.width && node.dimensions?.height);
  if (!children.length) return undefined;

  const left = Math.min(...children.map(node => node.position.x)) - 24;
  const top = Math.min(...children.map(node => node.position.y)) - 40;
  const width = Math.max(...children.map(node => node.position.x + node.dimensions!.width)) - left + 24;
  const height = Math.max(...children.map(node => node.position.y + node.dimensions!.height)) - top + 24;
  const shifts = (left || top)
    ? children.map(node => ({ id: node.id, dx: -left, dy: -top }))
    : [];
  const groupX = group.position?.x ?? 0;
  const groupY = group.position?.y ?? 0;
  return {
    groupId,
    position: { x: groupX + left, y: groupY + top },
    width,
    height,
    shifts,
  };
}

/**
 * 组从内到外依次要贴合的祖先链（含它自己）。
 * ACT: 先算出焦点组本身，再逐层向外。位置都是父坐标，层与层互不依赖，
 *      但先有内层结果外层才量得准——调用方按返回顺序落地即可。
 */
export function fitChainToVisible(nodes: CollapseNode[], focusId: string): FitPlanStep[] {
  const steps: FitPlanStep[] = [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  let current: string | undefined = focusId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const step = planFitVisible(nodes, current);
    if (step) steps.push(step);
    current = byId.get(current)?.parentNode;
  }
  return steps;
}
