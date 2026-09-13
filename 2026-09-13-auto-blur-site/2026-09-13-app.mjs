import { findFaces, facesForPeople } from './2026-09-13-faces.mjs';
import { missions, scenes } from './2026-09-13-learning.mjs';
import { letterbox, decodeOutput, processCandidates } from './2026-09-13-core.mjs';

const $ = id => document.getElementById(id);
const canvas = $('view');
const context = canvas.getContext('2d');
const original = document.createElement('canvas');
const originalContext = original.getContext('2d', { willReadFrequently: true });
const prepared = document.createElement('canvas');
prepared.width = prepared.height = 640;
const preparedContext = prepared.getContext('2d', { willReadFrequently: true });
const result = document.createElement('canvas');
const resultContext = result.getContext('2d');
const steps = [
  ['사진 준비', '사진 한 장에서 실험을 시작해요', '사진을 업로드하거나 카메라로 촬영하세요. 기본 샘플은 첨부된 역사 사진입니다. AI 탐지 실행을 누르면 실제 모델로 분석합니다.'],
  ['입력 맞추기', '모델이 받을 크기로 맞춰요', '사진 비율을 유지해 640×640 안에 넣고 빈 공간을 채웁니다. RGB 픽셀을 0~1 값으로 바꾸고, 색상별로 모아 모델에 전달합니다.'],
  ['후보 예측', '종류와 위치를 함께 예측해요', 'YOLO는 이미지 전체를 입력받아 여러 위치의 상자와 클래스 점수를 함께 예측합니다. 사진을 작은 창으로 순서대로 훑는 실행 방식이 아닙니다. 아래 상자는 아직 정답이 아닙니다.'],
  ['임계값 실험', '어느 점수부터 받아들일까요?', '슬라이더를 움직여 보세요. 사람 점수가 기준 이상인 후보만 통과합니다. 낮추면 오탐이 늘 수 있고, 높이면 실제 사람을 놓칠 수 있습니다.'],
  ['중복 정리', '같은 대상을 둘러싼 상자 정리', 'IoU는 두 상자의 교집합 넓이를 합집합 넓이로 나눈 값입니다. 높은 점수 상자부터 남기고, 많이 겹치는 후보를 제거합니다. 가까이 선 다른 사람도 잘못 제거될 수 있습니다.'],
  ['가리기', '찾은 위치의 픽셀을 바꿔요', '블러와 모자이크를 비교하세요. 상자를 눌러 잘못된 탐지를 제외하고, 누락 영역은 직접 추가할 수 있습니다. 사람 후보와 얼굴 전용 모델을 함께 사용해 얼굴 영역만 가립니다.'],
  ['결과 확인', '놓친 곳은 없는지 확인해요', '원본 비교 버튼으로 남은 단서를 확인하세요. 기준값을 바꾸면 가리는 영역도 달라집니다. 가림 효과만으로 완전한 익명화가 보장되지는 않습니다.'],
];
let step = 0;
let demo = false;
let faces = [];
let faceError = "";
let scene = -1;
let revealCount = 0;
let raw = [];
let processed = [];
let manual = [];
let excluded = new Set();
let session = null;
let busy = false;
let hasInference = false;
let showOriginal = false;
let timer = null;
let stream = null;
let cameraRequest = 0;
let imageRequest = 0;
let drawMode = false;
let drag = null;
let timing = {};
let runCount = 0;
let mapping;

const setStatus = message => { $('status').textContent = message; };
function setBusy(value) {
  busy = value;
  for (const id of ['upload', 'uploadTrigger', 'camera', 'demo', 'detect', 'capture']) $(id).disabled = value;
  $('detect').disabled = value;
  $('detect').textContent = value ? 'AI가 분석하고 있어요…' : '내 사진에서 AI 탐지 실행';
  updateScene();
}
function stopPlayback() {
  clearInterval(timer);
  timer = null;

}
function changeStep(next) {
  step = Math.max(0, Math.min(6, next));
  $('stepNumber').textContent = `STEP ${String(step + 1).padStart(2, '0')} / 07`;
  $('stepTitle').textContent = steps[step][1];
  $('stepDescription').textContent = steps[step][2];
  $('mission').innerHTML = `<p><b>할 일</b> ${missions[step][0]}</p><p><b>관찰하기</b> ${missions[step][1]}</p><p><b>생각하기</b> ${missions[step][2]}</p>`;
  $('slowPanel').hidden = step !== 2;
  if (step !== 2) { stopPlayback(); scene = -1; }
  updateScene();
  document.querySelectorAll('#steps button').forEach((button, index) => {
    if (index === step) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
  $('prev').disabled = step === 0;
  $('next').disabled = step === 6;
  if (step === 6) stopPlayback();
  draw();
}
steps.forEach(([name], index) => {
  const button = document.createElement('button');
  button.innerHTML = `<span>0${index + 1}</span>${name}`;
  button.onclick = () => { stopPlayback(); changeStep(index); };
  $('steps').append(button);
});

function prepareInput() {
  mapping = letterbox(original.width, original.height);
  preparedContext.fillStyle = 'rgb(114,114,114)';
  preparedContext.fillRect(0, 0, 640, 640);
  preparedContext.drawImage(original, mapping.padX, mapping.padY, mapping.w, mapping.h);
}
function resetInput() {
  stopPlayback();
  stopCamera();
  raw = [];
  faces = [];
  faceError = "";
  scene = -1;
  manual = [];
  excluded.clear();
  hasInference = false;
  timing = {};
  runCount = 0;
  showOriginal = false;
  drawMode = false;
  $('original').setAttribute('aria-pressed', 'false');
  $('addBox').setAttribute('aria-pressed', 'false');
  prepareInput();
  $('resolution').textContent = `${original.width} × ${original.height} px`;
  $('source').textContent = demo ? '첨부 샘플 사진 · 아직 분석하지 않음' : '내 사진 · 아직 분석하지 않음';
  setBusy(false);
  changeStep(0);
}
async function loadDemo() {
  if (busy) return;
  setBusy(true);
  try {
    const image = new Image();
    image.src = './2026-09-13-을사오적.jpg';
    await image.decode();
    imageRequest++;
    demo = true;
    original.width = image.naturalWidth;
    original.height = image.naturalHeight;
    originalContext.drawImage(image,0,0);
    resetInput();
    refresh();
    setStatus('첨부 샘플 사진입니다. AI 탐지 실행을 눌러 실제 사람 후보와 얼굴을 확인하세요.');
  } catch (error) { setStatus(`샘플을 읽지 못했습니다: ${error.message}`); }
  finally { setBusy(false); }
}
async function loadFile(file) {
  if (!file || busy) return;
  stopCamera();
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) {
    setStatus('JPG·PNG·WebP 사진을 선택하세요. 기존 실험은 유지됩니다.');
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    setStatus('15MB 이하의 사진을 선택하세요.');
    return;
  }
  const request = ++imageRequest;
  setBusy(true);
  try {
    const image = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (request !== imageRequest) { image.close(); return; }
    if (image.width * image.height > 20_000_000) { image.close(); throw new Error('2천만 픽셀 이하의 사진으로 줄여 주세요.'); }
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    original.width = Math.max(1, Math.round(image.width * scale));
    original.height = Math.max(1, Math.round(image.height * scale));
    originalContext.drawImage(image, 0, 0, original.width, original.height);
    image.close();
    demo = false;
    resetInput();
    refresh();
    setStatus(`${scale < 1 ? '긴 변 1600px로 줄였습니다. 저장도 이 작업 해상도를 사용합니다. ' : ''}사진 준비 완료. ‘AI 탐지 실행’을 눌러 주세요.`);
  } catch (error) {
    setStatus(`사진을 읽지 못했습니다. ${error.message}`);
  } finally {
    setBusy(false);
    $('upload').value = '';
  }
}

async function detect() {
  if (busy) return;
  stopPlayback();
  setBusy(true);
  setStatus('모델을 준비하고 있습니다. 첫 실행은 모델 로딩 시간이 필요합니다.');
  try {
    let start = performance.now();
    if (!session) {
      if (!window.ort) throw new Error('AI 실행 파일을 불러오지 못했습니다. 페이지를 새로고침해 주세요.');
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = new URL('./2026-09-13-runtime/', location.href).href;
      session = await ort.InferenceSession.create('./2026-09-13-yolov8n.onnx', { executionProviders: ['wasm'] });
    }
    timing.load = performance.now() - start;
    start = performance.now();
    prepareInput();
    const pixels = preparedContext.getImageData(0,0,640,640).data;
    const tensorData = new Float32Array(3 * 640 * 640);
    for (let i = 0; i < 640 * 640; i++) {
      tensorData[i] = pixels[i*4] / 255;
      tensorData[640*640+i] = pixels[i*4+1] / 255;
      tensorData[2*640*640+i] = pixels[i*4+2] / 255;
    }
    timing.pre = performance.now() - start;
    setStatus('사진 전체를 모델에 입력해 사람 후보를 계산합니다…');
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve,0)));
    const input = new ort.Tensor('float32', tensorData, [1,3,640,640]);
    start = performance.now();
    let outputs;
    try {
      outputs = await session.run({ [session.inputNames[0]]: input });
      timing.infer = performance.now() - start;
      raw = decodeOutput(outputs[session.outputNames[0]], mapping, original.width, original.height);
    } finally {
      input.dispose();
      if (outputs) Object.values(outputs).forEach(tensor => tensor.dispose());
    }
    setStatus('사람 후보 계산 완료. 얼굴 전용 모델로 얼굴 영역을 확인하고 있습니다…');
    const faceStart = performance.now();
    faces = [];
    faceError = '';
    try { faces = await findFaces(original,raw); }
    catch (error) { faceError = `얼굴 탐지 실패: ${error.message}`; }
    timing.face = performance.now()-faceStart;
    hasInference = true;
    runCount++;
    excluded.clear();
    $('source').textContent = '실제 추론 · YOLO 사람 후보 + BlazeFace 얼굴';
    refresh();
    changeStep(2);
    const count = processed.filter(box => box.status === 'keep').length;
    setStatus(faceError || (count ? `AI 탐지 완료. 사람 상자 ${count}개, 연결된 얼굴 ${activeBoxes().length}개. 얼굴 누락 여부를 직접 확인하세요.` : '분석 완료. 현재 기준을 통과한 사람 상자가 없습니다. 임계값을 낮추거나 얼굴을 직접 지정하세요.'));
  } catch (error) {
    setStatus(`AI 분석 실패: ${error.message} 예시 결과로 대체하지 않았습니다. 다시 실행할 수 있습니다.`);
  } finally {
    setBusy(false);
  }
}

function activeBoxes() {
  const people = processed.filter(box => box.status === 'keep' && !excluded.has(box.id));
  return [...facesForPeople(faces,people).filter(face=>!excluded.has(face.id)), ...manual];
}
function refresh() {
  const start = performance.now();
  processed = processCandidates(raw, Number($('threshold').value), Number($('iou').value));
  timing.post = performance.now() - start;
  $('passed').textContent = processed.filter(box => box.status !== 'low').length;
  $('kept').textContent = processed.filter(box => box.status === 'keep').length;
  $('masked').textContent = activeBoxes().length;
  const people = processed.filter(box=>box.status==='keep'&&!excluded.has(box.id));
  const missing = people.filter(person=>facesForPeople(faces,[person]).length===0).length;
  $('faceStatus').textContent = faceError || (!hasInference ? '탐지 실행 후 얼굴 결과를 확인할 수 있습니다.' : `얼굴 후보 ${faces.length}개 · 현재 가릴 얼굴 ${activeBoxes().length}개 · 연결된 얼굴이 없는 사람 상자 ${missing}개. 누락된 얼굴은 직접 추가하세요. 얼굴 모델의 점수 기준은 0.50으로 고정되어 사람 임계값과 다릅니다.`);
  const visible = processed.slice(0,60);
  $('candidateSummary').textContent = `전체 유효 후보 ${raw.length.toLocaleString()}개 · 점수순 ${visible.length}개 표시${raw.length > 60 ? ` · ${raw.length-60}개 화면 생략 (계산에는 포함)` : ''}`;
  $('candidates').replaceChildren();
  for (const box of [...visible,...faces,...manual]) {
    const row = document.createElement('tr');
    const reason = box.manual ? '직접 추가한 얼굴 영역' : box.face ? (activeBoxes().some(b=>b.id===box.id) ? '얼굴 모델 결과 · 가림 대상' : '얼굴 모델 결과 · 사람 기준/수동 제외로 가리지 않음') : box.status === 'low' ? '기준 미만 · 탈락' : box.status === 'nms' ? `중복 제거 · #${box.suppressedBy}와 IoU ${box.iou.toFixed(3)}` : '기준 통과 · 유지';
    row.innerHTML = `<td>#${box.id}</td><td>${box.manual ? '—' : `${box.score.toFixed(4)}<span class="scorebar"><i style="width:${Math.max(0, Math.min(100,box.score*100))}%"></i></span>`}</td><td>${reason}</td><td></td>`;
    if (box.manual || box.face || box.status === 'keep') {
      const button = document.createElement('button');
      button.textContent = box.manual ? '삭제' : excluded.has(box.id) ? '복원' : '제외';
      button.setAttribute('aria-label', `후보 ${box.id} ${button.textContent}`);
      button.onclick = () => { toggleBox(box); };
      row.lastChild.append(button);
    }
    $('candidates').append(row);
  }
  $('download').disabled = activeBoxes().length === 0;
  renderResult();
  draw();
  $('timings').textContent = hasInference ? `실제 추론 ${runCount}회 · 로딩 ${timing.load.toFixed(0)}ms · 전처리 ${timing.pre.toFixed(0)}ms · 추론 ${timing.infer.toFixed(0)}ms · 후처리 ${timing.post.toFixed(1)}ms · 얼굴 탐지 ${timing.face.toFixed(0)}ms · 가리기 ${timing.mask.toFixed(1)}ms` : '사진 준비 완료 · 아직 AI 탐지를 실행하지 않았습니다.';
}
function toggleBox(box) {
  if (box.manual) manual = manual.filter(item => item.id !== box.id);
  else if (excluded.has(box.id)) excluded.delete(box.id);
  else excluded.add(box.id);
  refresh();
}
function renderResult() {
  const start = performance.now();
  result.width = original.width;
  result.height = original.height;
  resultContext.drawImage(original,0,0);
  const strength = Number($('strength').value);
  const padding = Number($('padding').value) / 100;
  // 먼저 전체 원본에 한 번만 효과를 계산한 다음 선택 영역을 복사합니다.
  const effect = document.createElement('canvas');
  effect.width = original.width;
  effect.height = original.height;
  const effectContext = effect.getContext('2d');
  if ($('effect').value === 'blur') {
    // 경계 픽셀을 바깥으로 연장해 블러가 사진 가장자리에서 투명해지지 않게 합니다.
    const margin = strength * 3;
    const extended = document.createElement('canvas');
    extended.width = original.width + margin * 2;
    extended.height = original.height + margin * 2;
    const edge = extended.getContext('2d');
    edge.drawImage(original,margin,margin);
    edge.drawImage(original,0,0,original.width,1,margin,0,original.width,margin);
    edge.drawImage(original,0,original.height-1,original.width,1,margin,margin+original.height,original.width,margin);
    edge.drawImage(extended,margin,0,1,extended.height,0,0,margin,extended.height);
    edge.drawImage(extended,margin+original.width-1,0,1,extended.height,margin+original.width,0,margin,extended.height);
    effectContext.filter = `blur(${strength}px)`;
    effectContext.drawImage(extended,-margin,-margin);
    effectContext.filter = 'none';
  } else {
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.ceil(original.width / strength));
    small.height = Math.max(1, Math.ceil(original.height / strength));
    small.getContext('2d').drawImage(original,0,0,small.width,small.height);
    effectContext.imageSmoothingEnabled = false;
    effectContext.drawImage(small,0,0,effect.width,effect.height);
  }
  for (const box of activeBoxes()) {
    const x = Math.max(0, Math.floor(box.x-box.w*padding));
    const y = Math.max(0, Math.floor(box.y-box.h*padding));
    const w = Math.min(original.width,Math.ceil(box.x+box.w*(1+padding)))-x;
    const h = Math.min(original.height,Math.ceil(box.y+box.h*(1+padding)))-y;
    resultContext.drawImage(effect,x,y,w,h,x,y,w,h);
  }
  timing.mask = performance.now() - start;
}
function drawBox(box, color, dashed = false) {
  const scale = Math.max(original.width / 960, .6);
  context.strokeStyle = color;
  context.lineWidth = 2.5 * scale;
  context.setLineDash(dashed ? [8*scale,5*scale] : []);
  context.strokeRect(box.x,box.y,box.w,box.h);
  context.setLineDash([]);
  context.font = `bold ${16*scale}px sans-serif`;
  const label = box.manual ? `수동 ${box.id}` : box.face ? `얼굴 ${box.id}` : `#${box.id} · ${box.score.toFixed(2)}${excluded.has(box.id) ? ' 제외' : ''}`;
  const textWidth = context.measureText(label).width;
  context.fillStyle = '#092231';
  const y = Math.max(20*scale,box.y);
  context.fillRect(box.x,y-22*scale,textWidth+10*scale,22*scale);
  context.fillStyle = color;
  context.fillText(label,box.x+5*scale,y-6*scale);
}
function draw() {
  canvas.width = step === 1 && !showOriginal ? 640 : original.width;
  canvas.height = step === 1 && !showOriginal ? 640 : original.height;
  if (showOriginal) { context.drawImage(original,0,0); return; }
  if (step === 2 && scene === 0) { canvas.width=640; canvas.height=640; context.drawImage(prepared,0,0); return; }
  if (step === 2 && scene === 1) {
    canvas.width=960; canvas.height=540;
    context.fillStyle='#102938';context.fillRect(0,0,960,540);
    context.fillStyle='#e5f5fa';context.font='bold 28px sans-serif';context.fillText('특징 추출 · 개념도',45,65);
    const labels=['픽셀 입력','경계·무늬','형태의 조합','상자·클래스 점수'];
    labels.forEach((label,i)=>{
      const x=40+i*235;
      context.strokeStyle='#5de4c0';context.lineWidth=3;context.strokeRect(x,180,180,130);
      context.fillStyle='#e5f5fa';context.font='20px sans-serif';context.fillText(label,x+12,250);
      if(i<3)context.fillText('→',x+195,250);
    });
    context.font='20px sans-serif';context.fillText('실제 중간 텐서가 아닌 원리 설명용 도식입니다.',45,415);
    context.fillText('원본을 작은 창으로 차례차례 잘라 분류하는 과정과 구별하세요.',45,452);
    return;
  }
  if (step === 1) { context.drawImage(prepared,0,0); return; }
  context.drawImage(step >= 5 ? result : original,0,0);
  if (step >= 2 && step !== 6) {
    const boxes = step === 2 ? processed.slice(0,scene === 2 ? revealCount : 60) : step === 3 ? processed.slice(0,60) : processed.filter(box => box.status !== 'low').slice(0,60);
    for (const box of boxes) {
      if (step >= 5) continue;
      const color = step === 2 ? '#78dfff' : box.status === 'low' ? '#ffce70' : box.status === 'nms' && step >= 4 ? '#dda9fc' : '#6ee7b7';
      drawBox(box,color,box.status === 'low' && step >= 3 || excluded.has(box.id));
    }
    if(step>=5) for(const box of facesForPeople(faces,processed.filter(b=>b.status==='keep'&&!excluded.has(b.id)))) drawBox(box,'#6ee7b7',excluded.has(box.id));
    for (const box of manual) drawBox(box,'#ffffff');
  }
}
function setThreshold(value) {
  if (!Number.isFinite(value)) return;
  value = Math.min(1,Math.max(.01,Math.round(value*100)/100));
  $('threshold').value = value;
  $('thresholdNumber').value = value.toFixed(2);
  $('thresholdValue').value = value.toFixed(2);
  refresh();
  if (hasInference) setStatus(`임계값 ${value.toFixed(2)} 적용: 통과 후보 ${$('passed').textContent}개, NMS 후 ${$('kept').textContent}개. 모델을 다시 실행하지 않고 기준만 바꿨습니다.`);
}

function stopCamera() {
  cameraRequest++;
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  $('video').srcObject = null;
  $('cameraPanel').hidden = true;
}
async function startCamera() {
  if (busy) return;
  stopCamera();
  stopPlayback();
  const request = cameraRequest;
  if (!navigator.mediaDevices?.getUserMedia) { setStatus('카메라는 HTTPS 또는 localhost에서 사용할 수 있습니다. 사진 업로드도 가능합니다.'); return; }
  setStatus('브라우저의 카메라 권한 요청을 확인하세요.');
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal:1280 }, height: { ideal:720 } }, audio:false });
    if (request !== cameraRequest) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    $('video').srcObject = stream;
    $('cameraPanel').hidden = false;
    await $('video').play();
    setStatus('촬영 버튼을 누르면 사진 한 장을 가져오고 카메라를 끕니다.');
  } catch (error) {
    if (request !== cameraRequest) return;
    stopCamera();
    const messages = {NotAllowedError:'카메라 권한이 거부되었습니다. 주소창 권한을 확인하거나 사진을 업로드하세요.',NotFoundError:'카메라를 찾지 못했습니다. 사진 업로드를 이용하세요.',NotReadableError:'카메라를 다른 프로그램이 사용 중이거나 열 수 없습니다.'};
    setStatus(messages[error.name] || `카메라를 열지 못했습니다: ${error.message}`);
  }
}
function capture() {
  if (!$('video').videoWidth) { setStatus('카메라 영상이 준비된 뒤 촬영해 주세요.'); return; }
  const scale = Math.min(1,1600 / Math.max($('video').videoWidth,$('video').videoHeight));
  original.width = Math.round($('video').videoWidth*scale);
  original.height = Math.round($('video').videoHeight*scale);
  originalContext.drawImage($('video'),0,0,original.width,original.height);
  imageRequest++;
  demo = false;
  resetInput();
  refresh();
  setStatus('촬영 완료. 카메라를 껐습니다. 이제 AI 탐지를 실행하세요.');
}
function addManual(x,y,w,h) {
  if (![x,y,w,h].every(Number.isFinite) || x<0 || y<0 || w<1 || h<1 || x>=original.width || y>=original.height) { setStatus('사진 안의 x·y와 1 이상의 폭·높이를 입력하세요.'); return; }
  manual.push({id:`M${Date.now()}`,x,y,w:Math.min(w,original.width-x),h:Math.min(h,original.height-y),manual:true});
  changeStep(5);
  refresh();
}
function point(event) {
  const rect = canvas.getBoundingClientRect();
  // object-fit: contain으로 생긴 빈 여백을 제외해 원본 좌표로 환산합니다.
  const scale = Math.min(rect.width/canvas.width,rect.height/canvas.height);
  const offsetX = (rect.width-canvas.width*scale)/2;
  const offsetY = (rect.height-canvas.height*scale)/2;
  return {x:Math.max(0,Math.min(canvas.width,(event.clientX-rect.left-offsetX)/scale)),y:Math.max(0,Math.min(canvas.height,(event.clientY-rect.top-offsetY)/scale))};
}
canvas.onpointerdown = event => {
  if (showOriginal || step < 5) return;
  if (drawMode) { drag = point(event); canvas.setPointerCapture(event.pointerId); }
};
canvas.onpointermove = event => {
  if (!drag) return;
  draw();
  const end = point(event);
  context.strokeStyle = '#ffffff';
  context.lineWidth = 3;
  context.strokeRect(drag.x,drag.y,end.x-drag.x,end.y-drag.y);
};
canvas.onpointerup = event => {
  if (showOriginal || step < 5) return;
  const end = point(event);
  if (drag) {
    if (Math.abs(end.x-drag.x)>3 && Math.abs(end.y-drag.y)>3) addManual(Math.min(drag.x,end.x),Math.min(drag.y,end.y),Math.abs(end.x-drag.x),Math.abs(end.y-drag.y));
    drag = null;
    drawMode = false;
    $('addBox').setAttribute('aria-pressed','false');
    draw();
  } else if (!drawMode) {
    const box = [...manual,...facesForPeople(faces,processed.filter(b=>b.status==='keep'&&!excluded.has(b.id)))].find(b=>end.x>=b.x&&end.x<=b.x+b.w&&end.y>=b.y&&end.y<=b.y+b.h);
    if (box) toggleBox(box);
  }
};
canvas.onpointercancel = () => { drag = null; draw(); };

const questions = [
  ['사람 점수가 0.60인 후보에 임계값 0.60을 적용하면 어떻게 될까요?', ['점수가 기준과 같으므로 탈락한다','점수가 기준 이상이므로 통과한다','모델을 다시 학습해야 판단할 수 있다','정확도가 60%로 확정된다','사진의 60%에 블러를 적용한다'], 1, '점수 ≥ 임계값이면 통과합니다. 경계값이 같은 경우도 포함하며, 모델 점수가 정확도나 가림 비율을 뜻하지는 않습니다.'],
  ['NMS가 중복 후보를 정리하는 방법은?', ['모든 후보 상자를 하나로 합친다','점수가 낮은 상자부터 남긴다','같은 번호가 붙은 상자만 제거한다','높은 점수 상자를 남기고 IoU가 기준보다 큰 후보를 제거한다','사진에서 사람의 얼굴을 직접 흐리게 만든다'], 3, 'NMS는 높은 점수 후보부터 선택하고 많이 겹치는 후보를 억제합니다. IoU는 상자의 겹침 정도이며, 서로 다른 사람의 상자도 많이 겹치면 잘못 제거될 수 있습니다.'],
  ['이 실습에서 사람 탐지·얼굴 탐지·블러의 역할을 올바르게 설명한 것은?', ['사람 후보를 찾고 얼굴 위치를 확인한 뒤, 얼굴 영역의 픽셀을 흐리게 한다','사람 탐지 성공은 얼굴 탐지 성공도 항상 보장한다','블러 알고리즘이 사진 속 사람의 신원을 알아낸다','YOLO의 person 상자는 항상 얼굴 부분만 포함한다','신뢰도 임계값을 높이면 모든 얼굴을 빠짐없이 가릴 수 있다'], 0, '사람 탐지, 얼굴 탐지, 픽셀 처리는 서로 다른 단계입니다. 사람이나 얼굴을 놓칠 수 있으므로 결과를 확인하고 누락 영역을 보정해야 합니다.'],
];
const checked = new Set();
questions.forEach(([question,options,answer,explanation],index) => {
  const card = document.createElement('form');
  card.className = 'question';
  card.innerHTML = `<h3 id="q${index}"><span class="eyebrow">Q${index+1}.</span> ${question}</h3><div role="radiogroup" aria-labelledby="q${index}">${options.map((option,i)=>`<label><input type="radio" name="q${index}" value="${i}" required>${i+1}. ${option}</label>`).join('')}</div><button type="submit">정답 확인</button> <button type="reset">다시 풀기</button><p hidden role="status"></p>`;
  card.onsubmit = event => {
    event.preventDefault();
    const selected = Number(new FormData(card).get(`q${index}`));
    const feedback = card.querySelector('p');
    feedback.hidden = false;
    feedback.className = 'feedback';
    feedback.textContent = `${selected === answer ? '정답이에요.' : '다시 생각해 보세요.'} ${explanation}`;
    checked.add(index);
    $('quizProgress').textContent = `${checked.size} / 4 확인`;
  };
  card.onreset = () => {
    card.querySelector('p').hidden = true;
    checked.delete(index);
    $('quizProgress').textContent = `${checked.size} / 4 확인`;
  };
  $('questions').append(card);
});

// 주관식은 자동 채점하거나 예시답안을 제공하지 않습니다.
const discussion = document.createElement('form');
discussion.className = 'question discussion';
discussion.innerHTML = '<h3 id="discussionTitle"><span class="eyebrow">Q4. 주관식</span> 초해상도AI기술과 블러처리&amp;모자이크 기술은 어떤 관계일까요?</h3><label for="discussionAnswer">나의 생각</label><textarea id="discussionAnswer" name="discussionAnswer" rows="6" aria-labelledby="discussionTitle"></textarea><button type="submit">답 확인</button> <button type="reset">다시 쓰기</button><p hidden role="status"></p>';
discussion.onsubmit = event => {
  event.preventDefault();
  const feedback = discussion.querySelector('p');
  feedback.hidden = false;
  feedback.className = 'feedback';
  feedback.textContent = '힌트: 역함수와 비슷하긴 하다. 하지만 엄밀히 역함수 관계는 아니다.\n\n보다 상세한 설명은 Yangphago 선생님 수업에서 확인';
  feedback.style.whiteSpace = 'pre-line';
  checked.add(3);
  $('quizProgress').textContent = `${checked.size} / 4 확인`;
};
discussion.onreset = () => {
  discussion.querySelector('p').hidden = true;
  checked.delete(3);
  $('quizProgress').textContent = `${checked.size} / 4 확인`;
};
$('questions').append(discussion);

$('upload').onchange = event => loadFile(event.target.files[0]);
$('uploadTrigger').onclick = () => $('upload').click();
$('demo').onclick = loadDemo;
$('detect').onclick = detect;
$('camera').onclick = startCamera;
$('closeCamera').onclick = () => { stopCamera(); setStatus('카메라를 닫았습니다.'); };
$('capture').onclick = capture;
$('threshold').oninput = event => setThreshold(Number(event.target.value));
$('thresholdNumber').onchange = event => setThreshold(Number(event.target.value));
document.querySelectorAll('[data-threshold]').forEach(button => { button.onclick = () => { setThreshold(Number(button.dataset.threshold)); changeStep(Math.max(3,step)); }; });
for (const id of ['iou','strength','padding','effect']) {
  $(id).oninput = () => {
    $('iouValue').value = Number($('iou').value).toFixed(2);
    $('strengthValue').value = $('strength').value;
    $('paddingValue').value = `${$('padding').value}%`;
    refresh();
  };
}
$('prev').onclick = () => { stopPlayback(); changeStep(step-1); };
$('next').onclick = () => { stopPlayback(); changeStep(step+1); };
function updateScene() {
  $('slowStart').disabled = !hasInference || busy;
  $('sceneNext').disabled = scene < 0 || scene >= 3 || busy;
  $('sceneCopy').textContent = scene < 0 ? '탐지 실행 후 눌러 보세요. 실제 추론 시간과 분리한 설명 재생입니다.' : `${scene+1}/4 · ${scenes[scene][0]} — ${scenes[scene][1]}`;
}
function setScene(value) {
  stopPlayback();
  scene=value;
  showOriginal=false;
  $('original').setAttribute('aria-pressed','false');
  revealCount=0;
  updateScene();
  draw();
  if(scene===2) {
    timer=setInterval(()=>{
      revealCount=Math.min(revealCount+5,Math.min(60,processed.length));
      draw();
      if(revealCount>=Math.min(60,processed.length))stopPlayback();
    },350);
  }
}
$('slowStart').onclick = ()=>setScene(0);
$('sceneNext').onclick = ()=>setScene(Math.min(3,scene+1));
$('original').onclick = () => { showOriginal = !showOriginal; $('original').setAttribute('aria-pressed',String(showOriginal)); draw(); };
$('resetBoxes').onclick = () => { manual = []; excluded.clear(); refresh(); };
$('addBox').onclick = () => { showOriginal=false; $('original').setAttribute('aria-pressed','false'); drawMode=!drawMode; $('addBox').setAttribute('aria-pressed',String(drawMode)); changeStep(5); setStatus('사진에서 누락 영역을 드래그하거나, 좌표로 영역 추가를 이용하세요.'); };
$('addCoordinates').onclick = () => addManual(...['boxX','boxY','boxW','boxH'].map(id=>Number($(id).value)));
$('download').onclick = () => {
  if (!activeBoxes().length) return;
  result.toBlob(blob => {
    if (!blob) { setStatus('PNG를 만들지 못했습니다. 다시 시도하세요.'); return; }
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;
    link.download=`${new Date().toLocaleDateString('sv-SE')}-자동가림-${$('effect').value}.png`;
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  },'image/png');
};
$('largeText').onclick = () => {
  const enlarged = document.documentElement.classList.toggle('large');
  $('largeText').setAttribute('aria-pressed', String(enlarged));
  $('largeText').textContent = enlarged ? '글씨 작게' : '글씨 크게';
};
document.querySelectorAll('[data-answer]').forEach(button => { button.onclick = () => { $('predictionFeedback').textContent = `${button.dataset.answer === 'less' ? '맞아요.' : '통과 후보는 줄거나 같아집니다.'} 같은 후보 점수에서 기준만 높이므로 새로 통과하는 후보는 없습니다. 0.25와 0.75 버튼을 눌러 비교하세요.`; }; });
window.addEventListener('pagehide',()=>{ stopCamera(); stopPlayback(); });
loadDemo();
