import { processCandidates } from './2026-09-13-core.mjs';
let detector;

// 얼굴 점수 기준은 사람 후보 임계값과 별개이며 0.5로 고정합니다.
export async function findFaces(image, people) {
  if (!detector) {
    const { FaceDetector, FilesetResolver } = await import('./2026-09-13-face-runtime/vision_bundle.mjs');
    const files = await FilesetResolver.forVisionTasks(new URL('./2026-09-13-face-runtime/',import.meta.url).href);
    detector = await FaceDetector.createFromOptions(files, {
      baseOptions: { modelAssetPath: new URL('./2026-09-13-face-runtime/2026-09-13-blazeface.tflite',import.meta.url).href, delegate:'CPU' },
      runningMode:'IMAGE', minDetectionConfidence:.5, minSuppressionThreshold:.3,
    });
  }
  const found=[];
  function inspect(source, x=0, y=0, scale=1) {
    for (const detection of detector.detect(source).detections) {
      const b=detection.boundingBox;
      const left=Math.max(0,x+b.originX/scale);
      const top=Math.max(0,y+b.originY/scale);
      found.push({id:found.length+1,score:detection.categories[0].score,x:left,y:top,
        w:Math.max(0,Math.min(image.width,x+(b.originX+b.width)/scale)-left),
        h:Math.max(0,Math.min(image.height,y+(b.originY+b.height)/scale)-top)});
    }
  }
  // 전체 사진과 느슨한 사람 후보 영역을 분석해 작은 얼굴의 누락을 줄입니다.
  inspect(image);
  const proposals=processCandidates(people,.01,.45).filter(b=>b.status==='keep');
  for (const box of proposals) {
    const crop=document.createElement('canvas');
    const scale=Math.min(2,512/Math.max(box.w,box.h));
    crop.width=Math.max(1,Math.round(box.w*scale));
    crop.height=Math.max(1,Math.round(box.h*scale));
    crop.getContext('2d').drawImage(image,box.x,box.y,box.w,box.h,0,0,crop.width,crop.height);
    inspect(crop,box.x,box.y,scale);
  }
  return processCandidates(found.filter(b=>b.w>0&&b.h>0),.5,.3).filter(b=>b.status==='keep').map((b,i)=>({...b,id:`F${i+1}`,face:true}));
}

export function facesForPeople(faces, people) {
  return faces.filter(face=>people.some(person=>{
    const x=face.x+face.w/2;
    const y=face.y+face.h/2;
    return x>=person.x && x<=person.x+person.w && y>=person.y && y<=person.y+person.h;
  }));
}
