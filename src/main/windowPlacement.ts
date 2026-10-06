export function compactWindowBounds(workArea: { x: number; y: number; width: number; height: number }) {
  const margin = Math.min(16, Math.floor(Math.min(workArea.width, workArea.height) / 20));
  const width = Math.min(375, workArea.width - margin * 2);
  const height = Math.min(720, workArea.height - margin * 2);
  return { x: workArea.x + workArea.width - width - margin, y: workArea.y + margin, width, height };
}
