// Bound active PDF rendering while matching the displayed device pixels.
export function materialRenderScale(width: number, height: number, requestedWidth = 0): number {
  const desired = requestedWidth > 0 ? requestedWidth / width : Math.min(2, 1800 / Math.max(width, height));
  return Math.min(desired, 4096 / Math.max(width, height), Math.sqrt(8 * 1024 * 1024 / (width * height)));
}
