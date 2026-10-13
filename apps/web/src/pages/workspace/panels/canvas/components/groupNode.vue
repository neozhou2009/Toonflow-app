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
import { translate } from "@toonflow/i18n/vue";
import { summarize, isDefaultLabel, displayLabel as displayLabelOf, type SummaryNode } from "./groupSummary";
import {
  COLLAPSED_HEIGHT, collapsedStyle, collectDescendants, planExpand,
  rememberExpandedHeight, isCollapsedHeight, fitChainToVisible,
  type CollapseNode,
} from "./groupCollapse";
import { fitGroupBounds } from "../selectionNodes";

const props = withDefaults(defineProps<NodeProps & { readOnly?: boolean }>(), { readOnly: false });
const flow = useVueFlow();
const batchHistory = inject<((action: () => Promise<void>) => Promise<void>) | undefined>("batchCanvasHistory", undefined);
/** 节点数据。摘要与标题都要读 label；用 computed 保证 label 改动会联动。 */
const data = computed(() => (props.node?.data ?? {}) as { label?: string });
const editingLabel = ref(false);
const labelDraft = ref("");
const labelInput = ref<HTMLInputElement>();

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
  const named = (data.value.label ?? "").trim();
  // ACT: 未命名（含被 i18n 显示为 Group 等译名的）预填摘要当起点；
  //      用户一旦命名就预填原字。
  labelDraft.value = isDefaultLabel(named, translate) ? (summary.value || "分组") : named;
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
  return isCollapsedHeight(node as CollapseNode);
});

function nodeStyle(node: GraphNode): Record<string, string> {
  return typeof node.style === "object" && node.style ? node.style : {};
}

function toggleCollapse() {
  if (props.readOnly) return;
  const action = async () => {
    // ACT: 清框选状态要在改 hidden 之前——hidden 节点不再参与框选高亮，
    //      留着"框选激活"会把残留选区框进去，用户接着按成组快捷键
    //      （Ctrl/Alt+G）会拿残选再打一个组，表现为"点一下折叠多出分组"。
    flow.nodesSelectionActive.value = false;
    if (collapsed.value) await expandGroup();
    else await collapseGroup();
  };
  void Promise.resolve(batchHistory ? batchHistory(action) : action()).catch(error => {
    ElMessage.error(error instanceof Error ? error.message : "折叠分组失败");
  });
}

async function collapseGroup() {
  const node = flow.findNode(props.id);
  if (!node) return;
  // ACT: 记住展开时的高度（建组时写过 style.height；没写过就退到实际量到的高度），
  //      否则展开后丢掉尺寸，节点会挤在框外。
  props.data.expandedHeight = rememberExpandedHeight(node as CollapseNode);
  // ACT: 整棵子树全隐藏——只取直接子节点会让「分组里的分组」的孙节点漏在外面。
  for (const id of collectDescendants(flow.getNodes.value as CollapseNode[], props.id)) {
    flow.updateNode(id, { hidden: true, expandParent: false });
  }
  const collapsedHeightPx = COLLAPSED_HEIGHT;
  flow.updateNode(props.id, { hidden: false, style: collapsedStyle(node as CollapseNode), expandParent: false });

  // ACT: style 压了但 dimensions 还是旧值（如 300px），父组贴合时会按旧值算，
  //      框缩不下来——用户第二次反馈的正是这个。折叠态高度是确定值 COLLAPSED_HEIGHT，
  //      直接同步 dimensions，不等 DOM。
  node.dimensions = { ...node.dimensions, height: collapsedHeightPx };
  // ACT: 子树藏起来后父框必须收缩，否则下面留一大块空白。
  //      不能用上游 fitGroupBounds——它不过滤 hidden 子节点，量到旧尺寸永远缩不小，
  //      所以用只算可见子节点的 fitChainToVisible。等 DOM 量完再算，早了是旧值。
  await nextTick();
  // ACT: 焦点组自己压扁后不必再"按可见子节点贴合"（它只剩标题条高，贴合会算出
  //      内边距尺寸把 28 又撑大），只对它之上的祖先链逐层收缩。
  let ancestorId = node.parentNode;
  const visited = new Set<string>([props.id]);
  while (ancestorId && !visited.has(ancestorId)) {
    visited.add(ancestorId);
    const step = fitChainToVisible(flow.getNodes.value as CollapseNode[], ancestorId).at(0);
    if (!step) break;
    const target = flow.findNode(step.groupId);
    if (!target) break;
    const parent = target.parentNode ? flow.findNode(target.parentNode) : undefined;
    const px = parent?.computedPosition?.x ?? 0;
    const py = parent?.computedPosition?.y ?? 0;
    for (const shift of step.shifts) {
      const child = flow.findNode(shift.id);
      if (child) flow.updateNode(child.id, { position: { x: child.position.x + shift.dx, y: child.position.y + shift.dy } });
    }
    flow.updateNode(step.groupId, {
      position: { x: step.position.x - px, y: step.position.y - py },
      style: { ...(typeof target.style === "object" && target.style ? target.style : {}), width: `${step.width}px`, height: `${step.height}px` },
    });
    const live = flow.findNode(step.groupId);
    if (live) live.dimensions = { width: step.width, height: step.height };
    ancestorId = live?.parentNode;
  }
}

async function expandGroup() {
  const node = flow.findNode(props.id);
  if (!node) return;
  // ACT: 计划在 groupCollapse.ts 里算好（纯函数，可直接单测）：
  //      向上把被折叠的祖先一并展开、父框里其他子节点也显示，
  //      向下铺开自己这一支但尊重用户手动收起的内层分组。
  const plan = planExpand(flow.getNodes.value as CollapseNode[], props.id);
  for (const id of plan.unhide) flow.updateNode(id, { hidden: false, expandParent: false });
  for (const [id, style] of plan.restyle) flow.updateNode(id, { style, expandParent: false });
  // ACT: 展开一改动尺寸，父组框不会自己重新包住子内容——上游只在拖动松手时做贴合。
  //      用户截图里的"外层框没圈住 分组3"正是缺了这一步。
  //      这里复用上游同一套 fitGroupBounds（逐层重新计算边界与位置），把本组
  //      以及挂在它之上的祖先组全部重新贴合。等 DOM 量完尺寸再算，早了量的是旧值。
  await nextTick();
  const affected = new Set<GraphNode>();
  let chain: GraphNode | undefined = flow.findNode(props.id);
  while (chain) {
    affected.add(chain);
    chain = chain.parentNode ? flow.findNode(chain.parentNode) : undefined;
  }
  fitGroupBounds(flow.getNodes.value, affected);
}

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
  flow.getNodes.value.filter(node => node.parentNode === props.id) as SummaryNode[],
  translate));

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

  /* ACT: 摘要拼接后可能很长；折叠态标题限宽防撑爆，超出省略。 */
  &.collapsed .groupLabel {
    max-width: 240px;
    bottom: calc(100% + 4px);
  }

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
