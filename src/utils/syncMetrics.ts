/** Content-free, bounded counters for local diagnostics and reproducible tests. */
const metrics: Record<string, { count: number; milliseconds: number; bytes: number }> = {};

export function recordSyncMetric(name: string, milliseconds = 0, bytes = 0): void {
  const metric = metrics[name] ??= { count: 0, milliseconds: 0, bytes: 0 };
  metric.count++;
  metric.milliseconds += milliseconds;
  metric.bytes += bytes;
}

export function getSyncMetrics(): Readonly<typeof metrics> {
  return Object.fromEntries(Object.entries(metrics).map(([name, metric]) => [name, { ...metric }]));
}

export function resetSyncMetrics(): void {
  Object.keys(metrics).forEach(name => delete metrics[name]);
}
