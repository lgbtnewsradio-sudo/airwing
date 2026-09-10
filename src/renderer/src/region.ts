const sel = document.getElementById('sel') as HTMLDivElement;
const size = document.getElementById('size') as HTMLDivElement;
let start: { x: number; y: number } | null = null;
let rect = { x: 0, y: 0, width: 0, height: 0 };

function update(x: number, y: number): void {
  if (!start) return;
  rect = {
    x: Math.min(start.x, x),
    y: Math.min(start.y, y),
    width: Math.abs(x - start.x),
    height: Math.abs(y - start.y),
  };
  sel.style.display = 'block';
  sel.style.left = `${rect.x}px`;
  sel.style.top = `${rect.y}px`;
  sel.style.width = `${rect.width}px`;
  sel.style.height = `${rect.height}px`;
  size.style.display = 'block';
  size.style.left = `${rect.x + 4}px`;
  size.style.top = `${rect.y + rect.height + 6}px`;
  size.textContent = `${Math.round(rect.width * devicePixelRatio)} × ${Math.round(rect.height * devicePixelRatio)}`;
}

window.addEventListener('mousedown', (e) => {
  start = { x: e.clientX, y: e.clientY };
  update(e.clientX, e.clientY);
});
window.addEventListener('mousemove', (e) => update(e.clientX, e.clientY));
window.addEventListener('mouseup', (e) => {
  update(e.clientX, e.clientY);
  start = null;
  if (rect.width > 8 && rect.height > 8) window.airwing.region.result(rect);
  else window.airwing.region.result(null);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.airwing.region.result(null);
});
