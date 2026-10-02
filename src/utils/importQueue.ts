export async function runImportQueue<T extends { id: string }>(items: readonly T[], options: {
  stopped: () => boolean; save: (item: T) => Promise<string | null>; saved: (item: T) => void; progress: (item: T, index: number) => void;
}) {
  const failures: { id: string; error: string }[] = [];
  let saved = 0;
  for (const [index, item] of items.entries()) {
    if (options.stopped()) break;
    options.progress(item, index);
    let issue: string | null;
    try { issue = await options.save(item); } catch (reason) { issue = reason instanceof Error ? reason.message : '保存できませんでした。'; }
    if (issue) failures.push({ id: item.id, error: issue });
    else { saved += 1; options.saved(item); }
  }
  return { saved, failures, stopped: options.stopped() };
}
