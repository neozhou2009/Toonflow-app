<template>
  <div class="groupNode" :class="{ selected, resizing: !!resize, collapsed }">
    <input
      v-if="editingLabel && !readOnly"
      ref="labelInput"
      v-model="labelDraft"
      class="groupLabelInput nodrag nopan"
      aria-label="分组名称"
      @pointerdown.stop
      @mousedown.stop
      @click.stop
      @dblclick.stop
      @keydown.stop
      @keydown.enter="confirmLabel"
      @keydown.esc.prevent="editingLabel = false"
      @blur="saveLabel" />
    <span v-else class="groupLabel" :tabindex="readOnly ? undefined : 0" :title="readOnly ? displayLabel : `${displayLabel}（双击编辑名称）`" @dblclick.stop="editLabel" @keydown.enter.stop.prevent="editLabel">
      {{ displayLabel }}
    </span>
    <button
      v-if="!readOnly"
      class="collapseToggle nodrag nopan"
      type="button"
      :aria-expanded="!collapsed"
      :aria-label="collapsed ? '展开分组' : '折叠分组'"
      :title="collapsed ? '展开分组' : '折叠分组'"
      @pointerdown.stop
      @mousedown.stop
      @click.stop="toggleCollapse"
      @dblclick.stop>
      <component :is="collapsed ? IconChevronRight : IconChevronDown" :size="13" />
    </button>
    <button
      v-for="corner in readOnly ? [] : resizeCorners"
      :key="corner.name"
      class="resizeCorner nodrag nopan"
      :class="corner.name"
      type="button"
      :aria-label="`调整分组${corner.label}`"
      @pointerdown.stop.prevent="startResize($event, corner)"
      @pointermove.stop="moveResize"
      @pointerup.stop="finishResize"
      @pointercancel="finishResize"
      @lostpointercapture="finishResize"
      @mousedown.stop
      @click.stop
      @dblclick.stop />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useVueFlow, type GraphNode, type NodeProps } from "@vue-flow/core";
import { ElMessage } from "element-plus";
import { IconChevronDown, IconChevronRight } from "@tabler/icons-vue";
import { summarize, isDefaultLabel, displayLabel as displayLabelOf, type SummaryNode } from "./groupSummary";

const props = withDefaults(defineProps<NodeProps & { readOnly?: boolean }>(), { readOnly: false });
const flow = useVueFlow();
const batchHistory = inject<((action: () => Promise<void>) => Promise<void>) | undefined>("batchCanvasHistory", undefined);
const editingLabel = ref(false);
const labelDraft = ref("");
const labelInput = ref<HTMLInputElement>();
/** 折叠中的分组高度：刚好容纳边框与留白，让压缩后的框仍可被点击选中。 */
const COLLAPSED_HEIGHT = 28;
const resizeCorners = [
  { name: "topLeft", label: "左上角", x: -1, y: -1 },
  { name: "topRight", label: "右上角", x: 1, y: -1 },
  { name: "bottomLeft", label: "左下角", x: -1, y: 1 },
  { name: "bottomRight", label: "右下角", x: 1, y: 1 },
] as const;
type ResizeCorner = typeof resizeCorners[number];
const resize = shallowRef<{
  node: GraphNode;
  corner: ResizeCorner;
  element: HTMLElement;
  pointerId: number;
  point: { x: number; y: number };
  position: { x: number; y: number };
  width: number;
  height: number;
  resolve: () => void;
}>();

async function editLabel() {
  if (props.readOnly) return;
  // ACT: 拿摘要当预填起点，用户改几个字比从零起名容易得多。
  const named = (props.data.label ?? "").trim();
  labelDraft.value = isDefaultLabel(named) ? (summary.value || "分组") : named;
  editingLabel.value = true;
  await nextTick();
  labelInput.value?.select();
}

function saveLabel() {
  if (props.readOnly || !editingLabel.value) return;
  const label = labelDraft.value.trim();
  if (label) flow.updateNodeData(props.id, { label });
  editingLabel.value = false;
}

function confirmLabel(event: KeyboardEvent) {
  if (props.readOnly || event.isComposing) return;
  event.preventDefault();
  saveLabel();
}

function startResize(event: PointerEvent, corner: ResizeCorner) {
  if (props.readOnly || event.button !== 0 || resize.value) return;
  const node = flow.findNode(props.id);
  if (!node) return;
  const action = () => new Promise<void>(resolve => {
    if (props.readOnly) return resolve();
    const element = event.currentTarget as HTMLElement;
    resize.value = {
      node, corner, element, pointerId: event.pointerId,
      point: flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY }),
      position: { ...node.position }, width: node.dimensions.width, height: node.dimensions.height, resolve,
    };
    node.resizing = true;
    element.setPointerCapture(event.pointerId);
  });
  void (batchHistory ? batchHistory(action) : action()).catch(error => {
    finishResize();
    ElMessage.error(error instanceof Error ? error.message : "分组缩放失败");
  });
}

function moveResize(event: PointerEvent) {
  if (props.readOnly) return finishResize();
  const state = resize.value;
  if (!state || event.pointerId !== state.pointerId) return;
  if (flow.findNode(props.id) !== state.node) return finishResize();
  const point = flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  const width = Math.max(120, state.width + (point.x - state.point.x) * state.corner.x);
  const height = Math.max(80, state.height + (point.y - state.point.y) * state.corner.y);
  const position = {
    x: state.position.x + (state.corner.x < 0 ? state.width - width : 0),
    y: state.position.y + (state.corner.y < 0 ? state.height - height : 0),
  };
  const dx = position.x - state.node.position.x;
  const dy = position.y - state.node.position.y;
  for (const child of flow.getNodes.value) {
    if (child.parentNode === props.id) flow.updateNode(child.id, { position: { x: child.position.x - dx, y: child.position.y - dy } });
  }
  flow.updateNode(props.id, {
    position,
    style: { ...(typeof state.node.style === "object" ? state.node.style : {}), width: `${width}px`, height: `${height}px` },
  });
  state.node.dimensions = { width, height };
}

function finishResize(event?: PointerEvent) {
  const state = resize.value;
  if (!state || (event && event.pointerId !== state.pointerId)) return;
  resize.value = undefined;
  state.node.resizing = false;
  if (state.element.hasPointerCapture(state.pointerId)) state.element.releasePointerCapture(state.pointerId);
  state.resolve();
}

onBeforeUnmount(() => finishResize());
watch(() => props.readOnly, readOnly => {
  if (!readOnly) return;
  editingLabel.value = false;
  finishResize();
});

/* ------------------------------------------------------------------ */
/* 分组折叠                                                             */
/* ------------------------------------------------------------------ */
// ACT: vue-flow 的 hidden 不会从父节点级联到子节点（渲染判定只看节点自身），
//      且任一端 hidden 时连线自动不渲染，所以折叠必须逐个子节点设置。
//      collapsed / expandedHeight 存在 data 里：撤销历史只快照 data.label，
//      靠 node.style（非 runtime 字段，会被快照）驱动可见性，折叠态才不会在重算后丢失。
// ACT: 折叠状态以 node.style.height 为唯一事实来源（撤销历史会快照 style），
//      组件内只是派生出来的镜像，这样 Ctrl+Z 之后按钮方向与画面才一致。
//      找不到节点时按"未折叠"处理，避免节点被删后按钮卡在错误方向。
const collapsed = computed(() => {
  const node = flow.findNode(props.id);
  if (!node) return false;
  const height = Number.parseFloat(String(nodeStyle(node).height ?? ""));
  return Number.isFinite(height) && height <= COLLAPSED_HEIGHT;
});

function nodeStyle(node: GraphNode): Record<string, string> {
  return typeof node.style === "object" && node.style ? node.style : {};
}

/** parentNode → 子节点列表。ACT: 建一次表复用，嵌套分组下反复 getNodes 会重复遍历。 */
function childrenMap(): Map<string, GraphNode[]> {
  const map = new Map<string, GraphNode[]>();
  for (const node of flow.getNodes.value) {
    if (!node.parentNode) continue;
    const list = map.get(node.parentNode);
    if (list) list.push(node);
    else map.set(node.parentNode, [node]);
  }
  return map;
}

/** 后代节点 id（含嵌套分组内的），广度优先。ACT: visited 兜底，防数据异常成环死循环。 */
function getDescendantIds(rootId: string): string[] {
  const map = childrenMap();
  const result: string[] = [];
  const queue = [...(map.get(rootId) ?? [])];
  const visited = new Set<string>([rootId]);
  while (queue.length) {
    const node = queue.shift()!;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    result.push(node.id);
    queue.push(...(map.get(node.id) ?? []));
  }
  return result;
}

/** 分组是否处于折叠态（高度被压成标题条）。 */
function isNodeCollapsed(node: GraphNode | undefined): boolean {
  if (!node) return false;
  const height = Number.parseFloat(String(nodeStyle(node).height ?? ""));
  return Number.isFinite(height) && height <= COLLAPSED_HEIGHT;
}

function toggleCollapse() {
  if (props.readOnly) return;
  const action = () => {
    if (collapsed.value) expandGroup();
    else collapseGroup();
    // ACT: 折叠会把子节点设成 hidden，而 hidden 节点不再参与框选高亮。
    //      若此时画布还停在"框选激活"状态，用户接着按成组快捷键（Ctrl/Alt+G）
    //      会拿一份残留选区再打一个组，表现为"点一下折叠多出一个分组"。
    //      这里主动收摊，把那个状态清掉。
    flow.nodesSelectionActive.value = false;
    return Promise.resolve();
  };
  void Promise.resolve(batchHistory ? batchHistory(action) : action()).catch(error => {
    ElMessage.error(error instanceof Error ? error.message : "折叠分组失败");
  });
}

function collapseGroup() {
  const node = flow.findNode(props.id);
  if (!node) return;
  const style = nodeStyle(node);
  const height = Number.parseFloat(String(style.height ?? ""));
  // ACT: 记住展开时的高度。建组时写过 style.height；没写过就量一次当前实际高度，
  //      否则展开后会丢掉尺寸，节点会挤在框外。
  if (Number.isFinite(height) && height > COLLAPSED_HEIGHT) props.data.expandedHeight = height;
  else if (!props.data.expandedHeight && node.dimensions.height > COLLAPSED_HEIGHT) props.data.expandedHeight = node.dimensions.height;
  // ACT: 整棵子树全隐藏，嵌套分组里的孙节点才不会漏在外面。
  //      内层分组若本来是收起的，它的子节点已经隐藏，重复设置无副作用。
  for (const id of getDescendantIds(props.id)) flow.updateNode(id, { hidden: true, expandParent: false });
  flow.updateNode(props.id, { hidden: false, style: { ...style, height: `${COLLAPSED_HEIGHT}px` }, expandParent: false });
}

function expandGroup() {
  const node = flow.findNode(props.id);
  if (!node) return;
  const style = nodeStyle(node);
  const expanded = Number(props.data.expandedHeight);
  const restore = Number.isFinite(expanded) && expanded > COLLAPSED_HEIGHT ? `${expanded}px` : undefined;
  // ACT: 自顶向下展开；遇到自身处于折叠态的后代分组就止步，
  //      保留用户手动收起的内层分组——否则外层一次展开会把它一起还原。
  const map = childrenMap();
  const queue = [...(map.get(props.id) ?? [])];
  while (queue.length) {
    const child = queue.shift()!;
    flow.updateNode(child.id, { hidden: false, expandParent: false });
    if (isNodeCollapsed(child)) continue;
    queue.push(...(map.get(child.id) ?? []));
  }
  flow.updateNode(props.id, {
    hidden: false,
    // ACT: height 为 undefined 时清掉该键，而不是写成 "undefined"，否则 vue-flow 量不出尺寸。
    style: restore ? { ...style, height: restore } : Object.fromEntries(Object.entries(style).filter(([key]) => key !== "height")),
    expandParent: false,
  });
}

// ACT: 折叠中拖入新节点要跟着隐藏，否则会出现"分组收起但节点露在外面"。
//      只依赖子节点 id 列表：依赖里带上 hidden 会被自己触发，形成无谓的重复遍历。
watch(
  () => flow.getNodes.value.filter(node => node.parentNode === props.id).map(node => node.id).join(","),
  () => {
    if (!collapsed.value) return;
    for (const id of getDescendantIds(props.id)) {
      if (!flow.findNode(id)?.hidden) flow.updateNode(id, { hidden: true, expandParent: false });
    }
  },
);

/* ------------------------------------------------------------------ */
/* 折叠态内容摘要                                                       */
/* ------------------------------------------------------------------ */
// ACT: 折叠后只剩一条标题栏，用户认不出这是哪场戏。按内容实时生成摘要：
//      「首条文本片段 · 类型计数」。逻辑抽到 groupSummary.ts，
//      因为它是纯函数，抽出来才能被 dev-tools/test-group-collapse.mjs 直接测。
const summary = computed(() =>
  summarize(flow.getNodes.value.filter(node => node.parentNode === props.id) as SummaryNode[]));

/**
 * 标题显示：展开态用原名；折叠态在「未命名」时改用内容摘要。
 * ACT: 「未命名」判定为 label 为空或等于建组默认值「分组」——用户一旦自己命名就信他的，
 *      那个名本身就是他自己写的摘要。用默认值判断而非自存 renamed 标志，
 *      是因为撤销快照只保留 data.label，自存标志会在撤销后失效。
 */
const displayLabel = computed(() => displayLabelOf(data.label, collapsed.value,
  flow.getNodes.value.filter(node => node.parentNode === props.id) as SummaryNode[]));

watch(
  () => props.readOnly ? [] : flow.getNodes.value.filter(node => node.parentNode === props.id),
  children => {
    if (props.readOnly) return;
    // ACT: 拖动期间保持分组框不变，松手后由画布统一贴合内容。
    children.forEach(node => { node.expandParent = false; });
  },
  { immediate: true },
);
</script>

<style lang="scss" scoped>
.groupNode {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: color-mix(in srgb, var(--el-fill-color-light) 25%, transparent);

  &.selected {
    border-color: color-mix(in srgb, var(--el-color-primary) 50%, var(--el-border-color));
  }

  &:hover,
  &.selected,
  &.resizing {
    .resizeCorner { opacity: 1; }
  }

  .groupLabel,
  .groupLabelInput {
    position: absolute;
    left: 0;
    bottom: calc(100% + 8px);
    height: 22px;
    max-width: 100%;
    line-height: 20px;
  }

  .groupLabel {
    color: var(--el-text-color-secondary);
    font-size: 12px;
    user-select: none;
    display: inline-block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .groupLabelInput {
    box-sizing: border-box;
    width: 100%;
    padding: 0 3px;
    border: 1px solid var(--el-color-primary);
    border-radius: var(--el-border-radius-small);
    outline: none;
    background: var(--el-bg-color);
    color: var(--el-text-color-primary);
    font-family: inherit;
    font-size: 12px;
  }

  .resizeCorner {
    position: absolute;
    width: 9px;
    height: 9px;
    padding: 0;
    border: 1px solid var(--el-color-primary);
    border-radius: 2px;
    background: var(--el-bg-color);
    opacity: 0;
    touch-action: none;

    &:focus-visible { opacity: 1; }
    &.topLeft { top: -5px; left: -5px; cursor: nwse-resize; }
    &.topRight { top: -5px; right: -5px; cursor: nesw-resize; }
    &.bottomLeft { bottom: -5px; left: -5px; cursor: nesw-resize; }
    &.bottomRight { bottom: -5px; right: -5px; cursor: nwse-resize; }
  }

  /* ACT: 折叠时框已压成标题条，缩放角会顶到框外，且没有可缩放的内容，直接隐藏。 */
  &.collapsed .resizeCorner { display: none; }

  .collapseToggle {
    position: absolute;
    top: 3px;
    right: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: var(--el-border-radius-small);
    background: transparent;
    color: var(--el-text-color-secondary);
    cursor: pointer;
    opacity: 0;

    &:hover { background: var(--el-fill-color); color: var(--el-text-color-primary); }
    &:focus-visible { opacity: 1; outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
  }

  &:hover .collapseToggle,
  &.selected .collapseToggle,
  &.collapsed .collapseToggle { opacity: 1; }
}
</style>
