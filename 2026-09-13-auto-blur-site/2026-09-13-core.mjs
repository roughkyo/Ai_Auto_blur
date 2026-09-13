// 화면과 독립적인 좌표·임계값·중복 제거 계산입니다.
export function letterbox(width, height, size = 640) {
  const ratio = Math.min(size / width, size / height);
  const w = Math.round(width * ratio);
  const h = Math.round(height * ratio);
  return { w, h, padX: Math.floor((size - w) / 2), padY: Math.floor((size - h) / 2), scaleX: w / width, scaleY: h / height };
}
export function restoreBox(cx, cy, w, h, mapping, width, height) {
  const x = Math.max(0, Math.min(width, (cx - w / 2 - mapping.padX) / mapping.scaleX));
  const y = Math.max(0, Math.min(height, (cy - h / 2 - mapping.padY) / mapping.scaleY));
  const right = Math.max(0, Math.min(width, (cx + w / 2 - mapping.padX) / mapping.scaleX));
  const bottom = Math.max(0, Math.min(height, (cy + h / 2 - mapping.padY) / mapping.scaleY));
  return { x, y, w: Math.max(0, right - x), h: Math.max(0, bottom - y) };
}
export function iou(a, b) {
  const intersection = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}
export function processCandidates(candidates, threshold, overlap) {
  const sorted = candidates.map(box => ({ ...box, status: box.score >= threshold ? 'keep' : 'low' })).sort((a, b) => b.score - a.score || a.id - b.id);
  const kept = [];
  for (const box of sorted) {
    if (box.status === 'low') continue;
    const suppressor = kept.find(other => iou(box, other) > overlap);
    if (suppressor) {
      box.status = 'nms';
      box.suppressedBy = suppressor.id;
      box.iou = iou(box, suppressor);
    } else {
      kept.push(box);
    }
  }
  return sorted;
}
export function decodeOutput(tensor, mapping, width, height) {
  if (tensor.dims.join(',') !== '1,84,8400') throw new Error(`지원하지 않는 모델 출력: ${tensor.dims.join('×')}`);
  const data = tensor.data;
  const count = 8400;
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const score = data[4 * count + i];
    const box = restoreBox(data[i], data[count + i], data[count * 2 + i], data[count * 3 + i], mapping, width, height);
    if (!Number.isFinite(score) || !Object.values(box).every(Number.isFinite)) throw new Error('모델 출력에 유효하지 않은 수치가 있습니다.');
    if (box.w > 0 && box.h > 0) candidates.push({ id: i + 1, score, ...box });
  }
  return candidates;
}
