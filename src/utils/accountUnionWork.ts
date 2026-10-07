/** Remap only documented question references in a work checkpoint. The frozen
 * question content, answer-event IDs, dates and actual File/Blob bytes stay intact. */
export function remapUnionWork<T>(value: T, aliases: Record<string, string>): T {
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object' || item instanceof Blob || item instanceof Date) return item;
    if (Array.isArray(item)) return item.map(visit);
    const record = item as Record<string, unknown>, result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      if (key === 'questionId' && typeof child === 'string' || key === 'id' && typeof child === 'string' && Array.isArray(record.choices) && typeof record.setId === 'string') result[key] = aliases[child as string] ?? child;
      else if (['questionIds', 'targetIds'].includes(key) && Array.isArray(child)) result[key] = child.map(id => typeof id === 'string' ? aliases[id] ?? id : visit(id));
      else result[key] = visit(child);
    }
    return result;
  };
  return visit(value) as T;
}
