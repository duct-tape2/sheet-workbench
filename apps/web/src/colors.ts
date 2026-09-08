import {
  categoryIndex,
  labelKey,
  type Dataset,
  type CellValue,
} from "../../../packages/core/src/index";
export function colorFor(dataset: Dataset, value: CellValue | undefined) {
  return dataset.categoryColors?.[labelKey(value)] ?? categoryIndex(value);
}
