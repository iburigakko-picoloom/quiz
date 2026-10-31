export type InkPoint = { x: number; y: number };
export type MarkerStroke = { base: HTMLCanvasElement; points: InkPoint[] };
export interface InkSettings { tool: 'pen' | 'marker' | 'eraser'; color: string; width: number }

export function beginMarkerStroke(canvas: HTMLCanvasElement, point: InkPoint): MarkerStroke {
  const base = document.createElement('canvas'); base.width = canvas.width; base.height = canvas.height;
  base.getContext('2d')?.drawImage(canvas, 0, 0);
  return { base, points: [point] };
}

export function drawInkSegment(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, lastPoint: InkPoint, nextPoint: InkPoint, settings: InkSettings, marker: MarkerStroke | null, transparent = true) {
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = settings.width;
    context.strokeStyle = settings.tool === 'eraser' ? '#ffffff' : settings.color;
    if (transparent && settings.tool === 'eraser') context.globalCompositeOperation = 'destination-out';
    if (marker) {
      // Repaint the whole stroke once per frame: slow movement must not leave
      // darker overlapping dots. The original PDF remains a separate layer.
      context.save(); context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(marker.base, 0, 0); context.restore();
      context.globalAlpha = 0.48;
      context.globalCompositeOperation = 'multiply';
      marker.points.push(nextPoint);
    }
    context.beginPath();
    if (marker) {
      context.moveTo(marker.points[0].x, marker.points[0].y);
      for (const point of marker.points.slice(1)) context.lineTo(point.x, point.y);
    } else {
      context.moveTo(lastPoint.x, lastPoint.y);
      context.lineTo(nextPoint.x, nextPoint.y);
    }
    context.stroke();
    context.restore();
}
