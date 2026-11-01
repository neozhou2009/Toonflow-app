import { watch, type Ref } from "vue";
import formCreate, { type Rule } from "@form-create/element-ui";
import type { NodeMediaModel } from "@toonflow/nodes-scaffold/runtime";

export function useModelForm(data: Ref<{ model: string; other: Record<string, unknown> }>, model: Ref<NodeMediaModel | undefined>) {
  let previousModel = data.value.model;

  watch([() => data.value.model, model], ([modelKey, selectedModel]) => {
    const values = modelKey === previousModel ? data.value.other : {};
    previousModel = modelKey;
    if (!selectedModel) {
      if (values !== data.value.other) data.value.other = values;
      return;
    }
    const fields = new Map<string, unknown>();
    collectFields(formCreate.copyRules(selectedModel.rules ?? []), fields);
    data.value.other = Object.fromEntries([...fields].map(([field, value]) => [field, Object.hasOwn(values, field) ? values[field] : value]));
  }, { immediate: true, flush: "sync" });
}

function collectFields(rules: unknown, fields: Map<string, unknown>) {
  if (!Array.isArray(rules)) return;
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const item = rule as Rule;
    if (typeof item.field === "string") fields.set(item.field, item.value);
    collectFields(item.children, fields);
    if (Array.isArray(item.control)) {
      for (const control of item.control) collectFields(control?.rule, fields);
    }
  }
}
