// Normalize AI responses for display only; keep the saved original intact.
export function normalizeExplanationMarkdown(text: string) {
  return text.replace(/\r\n?/g, '\n').replace(/```(?:markdown|md)\s*\n([\s\S]*?)\n```/gi, '$1');
}

export function extractExplanationMedia(text: string) {
  const lines = normalizeExplanationMarkdown(text).split('\n'), media: string[] = [], body: string[] = [];
  let fence = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; const mark = line.trim().match(/^(`{3,}|~{3,})/);
    if (mark) { fence = fence ? '' : mark[1][0]; body.push(line); continue; }
    if (!fence && /^\s*!\[[^\]]*\]\([^\n]+\)\s*$/.test(line)) { media.push(line); continue; }
    const cells = (lines[i + 1] ?? '').trim().replace(/^\||\|$/g, '').split('|');
    if (!fence && line.includes('|') && cells.length > 0 && cells.every(cell => /^\s*:?-+:?\s*$/.test(cell))) {
      const table = [line, lines[++i]];
      while (i + 1 < lines.length && lines[i + 1].trim() && lines[i + 1].includes('|')) table.push(lines[++i]);
      media.push(table.join('\n')); continue;
    }
    body.push(line);
  }
  return { media, body: body.join('\n') };
}
