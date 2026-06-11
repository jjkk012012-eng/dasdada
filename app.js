'use strict';

const OCCT_CDN = 'https://cdn.jsdelivr.net/npm/occt-import-js@0.0.23/dist/';
const PROCESS_LIST = ['구매품','프로파일/압출','선반','판금/절곡','CNC/MCT','3D프린팅','사출','용접','분류 필요','제외'];
const MATERIAL_LIST = ['AL6061','SUS304','SS400','POM','ABS','PP'];
const state = { rates:null, parts:[], selectedId:null, scene:null, camera:null, renderer:null, controls:null, partObjects:new Map(), allGroup:null, occt:null };

function money(v){ return Math.round(v||0).toLocaleString('ko-KR')+'원'; }
function clamp(v,min,max){ return Math.max(min, Math.min(max, v)); }
function upper(s){ return (s||'').toString().toUpperCase(); }
function normName(s, fallback){ const t=(s||'').toString().trim().replace(/\s+/g,'_'); return t && t !== 'undefined' ? t : fallback; }
function flatten(arr){ return Array.isArray(arr) ? arr.flat ? arr.flat(Infinity) : [].concat(...arr) : []; }

window.addEventListener('DOMContentLoaded', init);

async function init(){
  state.rates = await loadRates();
  initViewer();
  bindEvents();
  renderRateEditors();
  await initOcct();
}

async function loadRates(){
  const fallback = {
    materials:{AL6061:{market:6200,mode:'percent',add:18,density:2.70},SUS304:{market:4700,mode:'percent',add:25,density:7.93},SS400:{market:1250,mode:'fixed',add:650,density:7.85},POM:{market:7200,mode:'direct',add:7200,density:1.41},ABS:{market:3200,mode:'direct',add:3200,density:1.04},PP:{market:2100,mode:'direct',add:2100,density:0.90}},
    margins:{'CNC/MCT':22,'선반':20,'판금/절곡':18,'3D프린팅':28,'사출':18,'프로파일/압출':15,'용접':22,'구매품':10,'제외':0,'분류 필요':0},
    cnc:{small:42000,medium:85000,large:160000,setup:35000,pocket:9000,step:6000,hole:500,tap:{M3:1200,M4:1500,M5:1800,M6:2200,M8:3200,M10:4800,M12:6200}},
    lathe:{small:30000,medium:65000,large:120000,groove:5000,thread:8000},
    sheet:{base:26000,cutPerM:1200,hole:350,tab:1200,bendSetup:18000,bendByThickness:[{max:1,price:1300},{max:2,price:2200},{max:3.2,price:3600},{max:6,price:6500}],susFactor:1.25,alFactor:1.1},
    printing:{fdmCm3:240,slaCm3:720,supportFactor:1.18,finish:10000}, injection:{moldSimple:2500000,moldNormal:4200000,moldComplex:6500000,unit:80,moldDefaultIncluded:false}, profile:{m2020:6500,m3030:8500,m4040:12500,m4080:23000,cut:800,tab:1300,bracket:1200}, weld:{base:30000,per100mm:4500,finish:15000}, purchase:{defaultUnit:2500,pipePerM:18000,squareTubePerM:21000,bearingDefault:9000,motorDefault:45000,sensorDefault:22000}
  };
  try{ const r=await fetch('data/rates.json',{cache:'no-store'}); if(r.ok) return await r.json(); }catch(e){}
  return fallback;
}

async function initOcct(){
  setLoadState('OCCT 엔진 로딩중...');
  if(typeof occtimportjs !== 'function'){
    setLoadState('OCCT 로딩 실패: 인터넷/CDN 확인 필요', true);
    return;
  }
  try{
    state.occt = await occtimportjs({ locateFile: (file) => OCCT_CDN + file });
    setLoadState('OCCT 준비 완료. STEP 파일을 업로드하세요.');
  }catch(e){
    console.error(e);
    setLoadState('OCCT 초기화 실패: 로컬 서버/인터넷/CDN 확인 필요', true);
  }
}

function setLoadState(msg, error=false){
  const el=document.getElementById('loadState');
  el.textContent=msg;
  el.className=error?'error':'';
  document.getElementById('parseStatus').textContent = error ? '오류' : (msg.includes('완료')?'완료':msg.includes('준비')?'대기':'분석중');
}

function bindEvents(){
  const input=document.getElementById('fileInput');
  input.addEventListener('change', e=>handleFile(e.target.files[0]));
  const dz=document.getElementById('dropzone');
  dz.addEventListener('dragover', e=>{e.preventDefault();dz.classList.add('drag');});
  dz.addEventListener('dragleave', ()=>dz.classList.remove('drag'));
  dz.addEventListener('drop', e=>{e.preventDefault();dz.classList.remove('drag');handleFile(e.dataTransfer.files[0]);});
  document.getElementById('showAllBtn').addEventListener('click', ()=>showAllParts());
  document.getElementById('fitBtn').addEventListener('click', ()=>fitCameraToObject(state.allGroup || state.scene));
  document.getElementById('recalcBtn').addEventListener('click', ()=>{ recalcAll(); renderPartsTable(); renderSummary(); });
  document.getElementById('exportBtn').addEventListener('click', exportCsv);
}

async function handleFile(file){
  if(!file) return;
  if(!state.occt){ setLoadState('OCCT가 아직 준비되지 않았습니다. 새로고침 후 다시 시도하세요.', true); return; }
  setLoadState('STEP 실제 형상 파싱중...');
  try{
    const buffer = await file.arrayBuffer();
    const result = state.occt.ReadStepFile(new Uint8Array(buffer), {
      linearUnit:'millimeter', linearDeflectionType:'bounding_box_ratio', linearDeflection:0.0008, angularDeflection:0.35
    });
    if(!result || result.success === false){
      console.error(result);
      throw new Error(result?.error || 'STEP 읽기 실패');
    }
    const rawParts = StepResultParser.extractLeafParts(result);
    if(!rawParts.length) throw new Error('실제 mesh가 있는 말단 파트를 찾지 못했습니다.');
    const parts = rawParts.map((p,i)=> PartFactory.create(p,i));
    state.parts = mergeByName(parts);
    recalcAll();
    buildSceneFromParts(state.parts);
    renderPartsTable();
    renderSummary({asmCount:countAssemblyNodes(result.root)});
    selectPart(state.parts[0]?.id);
    setLoadState(`완료: 말단 파트 ${state.parts.length}개`);
  }catch(e){
    console.error(e);
    state.parts=[]; clearScene(); renderPartsTable(); renderSummary();
    setLoadState('파싱 실패: '+e.message, true);
  }
}

const StepResultParser = {
  extractLeafParts(result){
    const root = result.root || {};
    const meshes = result.meshes || [];
    const nodes=[];
    function hasMeshInChildren(node){
      if(!node?.children?.length) return false;
      return node.children.some(c => (c.meshes && c.meshes.length) || hasMeshInChildren(c));
    }
    function walk(node, path=[]){
      const name = normName(node.name, 'NODE');
      const newPath = [...path, name];
      const meshIds = (node.meshes||[]).filter(x => Number.isInteger(x) && meshes[x]);
      const childHasMesh = hasMeshInChildren(node);
      if(meshIds.length && !childHasMesh){
        nodes.push({ name, path:newPath.join(' / '), meshIds, meshes:meshIds.map(id=>meshes[id]) });
      }
      (node.children||[]).forEach(c=>walk(c,newPath));
    }
    walk(root, []);
    if(!nodes.length && root.meshes?.length){
      nodes.push({ name:normName(root.name,'ROOT_PART'), path:normName(root.name,'ROOT_PART'), meshIds:root.meshes, meshes:root.meshes.map(id=>meshes[id]).filter(Boolean) });
    }
    return nodes.filter(n => n.meshes.length && !Rules.isAssembly(n.name));
  }
};
function countAssemblyNodes(node){ let n=0; function w(x){ if(x?.children?.length) n++; (x.children||[]).forEach(w); } w(node||{}); return Math.max(0,n-1); }

const Rules = {
  isAssembly(name){ return /(^|[_\-\s])(ASM|ASSY|ASSEMBLY|SUBASM|SUB_ASSY|조립|어셈|전체|UNIT)([_\-\s]|$)/i.test(name||''); },
  isPurchase(name){ return /(BOLT|NUT|WASHER|BEARING|SENSOR|MOTOR|CYLINDER|SCREW|SPRING|BALL|LM|GUIDE_RAIL|HINGE|HANDLE|KNOB|COUPLER|VALVE|FITTING|PIPE|TUBE|SQUARE_TUBE|ROUND_TUBE|각관|파이프|튜브|배관)/i.test(name||''); },
  isPipe(name){ return /(PIPE|TUBE|SQUARE_TUBE|ROUND_TUBE|각관|파이프|튜브|배관)/i.test(name||''); },
  isProfile(name){ const n=upper(name); if(/PIPE|TUBE|각관|파이프|튜브/.test(n)) return false; return /(PROFILE|AL_PROFILE|ALFRAME|FRAME_?(2020|3030|4040|4080|4545|5050|6060)|(^|_)20X20|30X30|40X40|40X80)/.test(n); },
  isLathe(name){ return /(SHAFT|PIN|BUSH|BUSHING|ROLLER|SPACER_ROUND|COLLAR|AXIS|축|핀|부싱|롤러)/i.test(name||''); },
  bendHint(name){ return /(BEND|BENT|FOLD|FLANGE|HEM|L_BRACKET|U_BRACKET|Z_BRACKET|절곡|접힘|플랜지)/i.test(name||''); },
  sheetHint(name){ return /(COVER|PANEL|BRACKET|SHEET|_1T|_1\.5T|_2T|_3T|_4T|_5T|_6T|커버|판넬|브라켓)/i.test(name||''); },
  cncHint(name){ return /(BASE|BLOCK|JIG|FIXTURE|MOUNT|HOLDER|SUPPORT|ADAPTER|CLAMP|GUIDE|PLATE|BRACKET|HOUSING|가공|지그|베이스)/i.test(name||''); }
};

const PartFactory = {
  create(raw, idx){
    const geom = GeometryAnalyzer.analyze(raw.meshes);
    const feature = FeatureAnalyzer.analyze(raw.name, geom, raw.meshes);
    const cls = ProcessClassifier.classify(raw.name, geom, feature);
    const material = defaultMaterial(cls.process, raw.name);
    return {
      id:'part_'+idx+'_'+Math.random().toString(36).slice(2,7), name:raw.name || `PART_${idx+1}`, path:raw.path, source:raw,
      geom, feature, recommendation:cls, process:cls.process, material, qty:1,
      thickness: geom.thickness || 0, tapCount: feature.tapCount, bendCount: feature.bendCount,
      margin: state.rates.margins[cls.process] ?? 0, purchaseUnit: estimatePurchaseUnit(raw.name, geom), quote:0, costLines:[]
    };
  }
};
function defaultMaterial(process, name){ if(process==='구매품') return 'SS400'; if(process==='3D프린팅'||process==='사출') return Rules.isPurchase(name)?'SS400':'ABS'; if(/SUS|STS|304/i.test(name)) return 'SUS304'; return 'AL6061'; }

const GeometryAnalyzer = {
  analyze(meshes){
    const vertices=[]; const triangles=[]; const faceGroups=[]; let triOffset=0;
    for(const mesh of meshes){
      const pos = mesh?.attributes?.position?.array || [];
      const idx = flatten(mesh?.index?.array || []);
      const base = vertices.length/3;
      for(const v of pos) vertices.push(v);
      for(let i=0;i<idx.length;i+=3){ triangles.push([idx[i]+base,idx[i+1]+base,idx[i+2]+base]); }
      const brep = mesh.brep_faces || [];
      brep.forEach(f=>{
        const first = (f.first ?? 0) + triOffset;
        const last = (f.last ?? first) + triOffset;
        faceGroups.push({ first, last });
      });
      triOffset += idx.length/3;
    }
    const bbox = computeBBox(vertices);
    const dims = { x:bbox.max.x-bbox.min.x, y:bbox.max.y-bbox.min.y, z:bbox.max.z-bbox.min.z };
    const sorted = [dims.x,dims.y,dims.z].sort((a,b)=>a-b);
    const triStats = computeTriangleStats(vertices, triangles);
    const volumeMm3 = Math.abs(triStats.volume) || bboxVolume(dims)*0.25;
    const surfaceMm2 = triStats.area || 0;
    const thickness = sorted[0] > 0 && sorted[0] < 12 ? round1(sorted[0]) : 0;
    const bboxVol = bboxVolume(dims);
    const fillRatio = bboxVol ? clamp(volumeMm3/bboxVol,0,1) : 0;
    const faceStats = analyzeBrepFaces(vertices, triangles, faceGroups);
    return { vertices, triangles, bbox, dims, sortedDims:sorted, volumeMm3, surfaceMm2, thickness, fillRatio, faceStats };
  }
};
function computeBBox(vertices){
  const min={x:Infinity,y:Infinity,z:Infinity}, max={x:-Infinity,y:-Infinity,z:-Infinity};
  for(let i=0;i<vertices.length;i+=3){ const x=vertices[i],y=vertices[i+1],z=vertices[i+2]; if(x<min.x)min.x=x;if(y<min.y)min.y=y;if(z<min.z)min.z=z;if(x>max.x)max.x=x;if(y>max.y)max.y=y;if(z>max.z)max.z=z; }
  if(!isFinite(min.x)) return {min:{x:0,y:0,z:0},max:{x:0,y:0,z:0}};
  return {min,max};
}
function bboxVolume(d){ return Math.max(0,d.x*d.y*d.z); }
function computeTriangleStats(vertices, triangles){
  let area=0, volume=0;
  for(const [ia,ib,ic] of triangles){
    const a=v3(vertices,ia), b=v3(vertices,ib), c=v3(vertices,ic);
    const ab=sub(b,a), ac=sub(c,a); const cr=cross(ab,ac);
    area += len(cr)/2;
    volume += dot(a,cross(b,c))/6;
  }
  return {area, volume};
}
function analyzeBrepFaces(vertices, triangles, groups){
  const out=[];
  for(const g of groups){
    let area=0; const normals=[]; const box={min:{x:Infinity,y:Infinity,z:Infinity},max:{x:-Infinity,y:-Infinity,z:-Infinity}};
    for(let ti=g.first; ti<=g.last && ti<triangles.length; ti++){
      const [ia,ib,ic]=triangles[ti]; const a=v3(vertices,ia), b=v3(vertices,ib), c=v3(vertices,ic);
      [a,b,c].forEach(p=>{box.min.x=Math.min(box.min.x,p.x);box.min.y=Math.min(box.min.y,p.y);box.min.z=Math.min(box.min.z,p.z);box.max.x=Math.max(box.max.x,p.x);box.max.y=Math.max(box.max.y,p.y);box.max.z=Math.max(box.max.z,p.z);});
      const n=normalize(cross(sub(b,a),sub(c,a))); normals.push(n); area += len(cross(sub(b,a),sub(c,a)))/2;
    }
    if(!normals.length) continue;
    const avg=normalize(normals.reduce((s,n)=>({x:s.x+n.x,y:s.y+n.y,z:s.z+n.z}),{x:0,y:0,z:0}));
    const variance = 1 - clamp(len(normals.reduce((s,n)=>({x:s.x+n.x,y:s.y+n.y,z:s.z+n.z}),{x:0,y:0,z:0}))/normals.length,0,1);
    const span={x:box.max.x-box.min.x,y:box.max.y-box.min.y,z:box.max.z-box.min.z};
    out.push({area, avg, variance, span, maxSpan:Math.max(span.x,span.y,span.z), minSpan:Math.min(span.x||99999,span.y||99999,span.z||99999)});
  }
  return out;
}
function v3(arr,i){ return {x:arr[i*3], y:arr[i*3+1], z:arr[i*3+2]}; }
function sub(a,b){return{x:a.x-b.x,y:a.y-b.y,z:a.z-b.z};} function cross(a,b){return{x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x};} function dot(a,b){return a.x*b.x+a.y*b.y+a.z*b.z;} function len(a){return Math.sqrt(dot(a,a));} function normalize(a){ const l=len(a)||1; return{x:a.x/l,y:a.y/l,z:a.z/l}; } function round1(x){ return Math.round(x*10)/10; }

const FeatureAnalyzer = {
  analyze(name, geom){
    const d=geom.dims, min=geom.sortedDims[0], mid=geom.sortedDims[1], max=geom.sortedDims[2];
    const sheetLike = min>0 && min<=6.5 && (max/(min||1)>12) && (mid/(min||1)>4);
    const pipe = Rules.isPipe(name);
    const profile = Rules.isProfile(name);
    const lathe = Rules.isLathe(name) || (max/(mid||1)>3.5 && Math.abs(mid-min)/Math.max(1,mid)<0.18 && !pipe && !profile);
    const realBends = BendDetector.detect(name, geom, sheetLike, pipe, profile);
    const bendCount = realBends.length;
    const holeCount = estimateHoles(name, geom);
    const tapCount = estimateTaps(name, holeCount, geom.thickness);
    const pocketCount = estimatePockets(name, geom, sheetLike, pipe, profile);
    const stepCount = (!sheetLike && !pipe && !profile) ? Math.min(8, Math.round(geom.faceStats.filter(f=>f.variance<0.02 && f.area>100).length/6)) : 0;
    return { sheetLike, pipe, profile, lathe, bendCandidates:realBends, bendCount, holeCount, tapCount, pocketCount, stepCount };
  }
};

const BendDetector = {
  detect(name, geom, sheetLike, pipe, profile){
    if(pipe || profile || !sheetLike) return [];
    const hinted = Rules.bendHint(name);
    const t = geom.thickness || geom.sortedDims[0];
    if(!t || t>6.5) return [];
    const curvedFaces = geom.faceStats.filter(f => {
      const slenderEnough = f.maxSpan > 18 && f.area > t * 12;
      const curved = f.variance > 0.035;
      const notHugeFreeform = f.area < (geom.surfaceMm2 * 0.35);
      return curved && slenderEnough && notHugeFreeform;
    });
    // 이름 힌트만으로 절곡 횟수를 뻥튀기하지 않는다. 실제 곡면 후보가 없으면 0회.
    const candidates = curvedFaces.slice(0, 12).map((f,i)=>({ id:i+1, length:Math.round(f.maxSpan), thickness:t, confidence: hinted ? '높음' : '보통', reason:'같은 두께 판재의 곡면/R 후보' }));
    return candidates;
  }
};
function estimateHoles(name, geom){
  const n=upper(name); const explicit = n.match(/(?:HOLE|H)(\d{1,2})/); if(explicit) return +explicit[1];
  const cylFaces = geom.faceStats.filter(f=>f.variance>0.025 && f.maxSpan <= Math.max(geom.sortedDims[1], 30) && f.area > 20).length;
  if(/BOLT|NUT|BEARING|PIPE|TUBE/.test(n)) return 0;
  return clamp(Math.round(cylFaces/2),0,24);
}
function estimateTaps(name, holeCount, thickness){
  const n=upper(name); const explicit=n.match(/(?:TAP|M)(\d{1,2})/); if(explicit && holeCount) return Math.min(holeCount, Math.max(1, Math.round(holeCount/2)));
  if(thickness>=4 && holeCount>0 && /(BASE|PLATE|BLOCK|JIG|MOUNT|BRACKET)/.test(n)) return Math.min(holeCount, Math.ceil(holeCount*0.35));
  return 0;
}
function estimatePockets(name, geom, sheetLike, pipe, profile){
  if(sheetLike||pipe||profile) return 0;
  const n=upper(name); let v=0; if(/POCKET|SLOT|홈|자리|COUNTER|CB/.test(n)) v+=2; if(geom.fillRatio<0.45) v+=1; return clamp(v,0,6);
}

const ProcessClassifier = {
  classify(name, geom, f){
    const reasons=[];
    if(Rules.isPurchase(name)){ reasons.push('표준품/파이프/튜브/각관/구매품 이름'); return out('구매품',95,reasons); }
    if(f.profile){ reasons.push('프로파일 규격/일정 단면 이름'); return out('프로파일/압출',92,reasons); }
    if(f.lathe){ reasons.push('축/핀/부싱류 또는 회전체 비율'); return out('선반',82,reasons); }
    if(f.sheetLike){
      if(f.bendCount>0){ reasons.push('얇은 판재형 + 실제 곡면/R 절곡 후보'); return out('판금/절곡',86,reasons); }
      reasons.push('얇은 판재형. 절곡은 0회로 공장 확인 필요'); return out('판금/절곡',68,reasons);
    }
    if(Rules.cncHint(name) || f.pocketCount>0 || f.tapCount>0 || f.stepCount>1){ reasons.push('구매품/프로파일/선반/판금 제외 후 절삭 특징'); return out('CNC/MCT',72,reasons); }
    if(Rules.sheetHint(name)){ reasons.push('커버/패널류이나 판재 두께 판단 불확실'); return out('분류 필요',45,reasons); }
    return out('분류 필요',30,['자동 확정 불가. 공장이 공법 선택']);
  }
};
function out(process, score, reasons){ return {process, score, confidence:score>=85?'높음':score>=65?'보통':'낮음', reasons}; }

function mergeByName(parts){
  const map=new Map();
  for(const p of parts){
    const key=upper(p.name);
    if(map.has(key)) map.get(key).qty += 1;
    else map.set(key,p);
  }
  return [...map.values()];
}

function recalcAll(){ state.parts.forEach(p=>calculateQuote(p)); renderSummary(); }
function materialRate(mat){ const m=state.rates.materials[mat] || state.rates.materials.AL6061; if(m.mode==='fixed') return m.market + m.add; if(m.mode==='percent') return m.market * (1+m.add/100); return m.add; }
function density(mat){ return (state.rates.materials[mat]||state.rates.materials.AL6061).density; }
function kgFromVolume(volumeMm3, mat){ return volumeMm3/1_000_000 * density(mat); }
function partSizeClass(geom){ const max=Math.max(geom.dims.x,geom.dims.y,geom.dims.z); if(max<120) return 'small'; if(max<350) return 'medium'; return 'large'; }
function margin(p, subtotal){ return subtotal * ((+p.margin||0)/100); }
function calculateQuote(p){
  const r=state.rates; const g=p.geom; const f=p.feature; let lines=[]; let subtotal=0; const qty=+p.qty||1;
  const matPrice=materialRate(p.material);
  const stockKg=kgFromVolume(bboxVolume(g.dims), p.material);
  const realKg=kgFromVolume(g.volumeMm3, p.material);
  if(p.process==='제외'){ p.quote=0; p.costLines=[]; return; }
  if(p.process==='구매품'){
    subtotal = (+p.purchaseUnit||0) * qty; lines.push(['구매품',subtotal]);
  } else if(p.process==='프로파일/압출'){
    const lenM = Math.max(g.dims.x,g.dims.y,g.dims.z)/1000; const rate = profileRate(p.name); const cut=qty*2*r.profile.cut; subtotal=(lenM*rate + r.profile.bracket*2 + (+p.tapCount||0)*r.profile.tab)*qty + cut; lines.push(['프로파일/절단/탭',subtotal]);
  } else if(p.process==='선반'){
    const cls=partSizeClass(g); subtotal=(realKg*matPrice + r.lathe[cls] + f.pocketCount*r.lathe.groove + (+p.tapCount||0)*r.lathe.thread)*qty; lines.push(['선반 가공',subtotal]);
  } else if(p.process==='판금/절곡'){
    const sheetMat = Math.max(realKg*matPrice, (g.surfaceMm2/2)*(+p.thickness||g.thickness||1.6)/1_000_000*density(p.material)*matPrice);
    const bendUnit = bendUnitPrice(+p.thickness||g.thickness||1.6); const bend = (+p.bendCount||0) > 0 ? r.sheet.bendSetup + (+p.bendCount||0)*bendUnit*materialBendFactor(p.material) : 0;
    const cut = Math.max(g.dims.x,g.dims.y)*2/1000*r.sheet.cutPerM; subtotal=(sheetMat + r.sheet.base + cut + (+p.tapCount||0)*r.sheet.tab + f.holeCount*r.sheet.hole + bend)*qty; lines.push(['판금/절곡',subtotal]);
  } else if(p.process==='CNC/MCT'){
    const cls=partSizeClass(g); subtotal=(stockKg*matPrice + r.cnc[cls] + r.cnc.setup + f.pocketCount*r.cnc.pocket + f.stepCount*r.cnc.step + f.holeCount*r.cnc.hole + (+p.tapCount||0)*tapUnit(p))*qty; lines.push(['CNC/MCT',subtotal]);
  } else if(p.process==='3D프린팅'){
    subtotal=(g.volumeMm3/1000*r.printing.fdmCm3 + r.printing.finish)*qty; lines.push(['3D프린팅',subtotal]);
  } else if(p.process==='사출'){
    const mold = r.injection.moldDefaultIncluded ? r.injection.moldSimple : 0; subtotal=mold + (realKg*matPrice + r.injection.unit)*qty; lines.push(['사출',subtotal]);
  } else if(p.process==='용접'){
    subtotal=(r.weld.base + Math.max(g.dims.x,g.dims.y)/100*r.weld.per100mm + r.weld.finish)*qty; lines.push(['용접',subtotal]);
  } else {
    subtotal=0; lines.push(['분류 필요',0]);
  }
  const m=margin(p, subtotal); p.quote=subtotal+m; p.costLines=[...lines,['마진',m]];
}
function profileRate(name){ const n=upper(name); if(/4080|40X80/.test(n)) return state.rates.profile.m4080; if(/4040|40X40/.test(n)) return state.rates.profile.m4040; if(/3030|30X30/.test(n)) return state.rates.profile.m3030; return state.rates.profile.m2020; }
function bendUnitPrice(t){ const row=state.rates.sheet.bendByThickness.find(x=>t<=x.max) || state.rates.sheet.bendByThickness.at(-1); return row.price; }
function materialBendFactor(mat){ if(mat==='SUS304') return state.rates.sheet.susFactor; if(mat==='AL6061') return state.rates.sheet.alFactor; return 1; }
function tapUnit(p){ const t=p.thickness||p.geom.thickness||3; if(t<=3) return state.rates.cnc.tap.M4; if(t<=6) return state.rates.cnc.tap.M6; return state.rates.cnc.tap.M8; }
function estimatePurchaseUnit(name, geom){ const r=state.rates.purchase; const n=upper(name); const lenM=Math.max(geom.dims.x,geom.dims.y,geom.dims.z)/1000; if(/PIPE|TUBE|파이프|튜브/.test(n)) return Math.max(r.defaultUnit, lenM * (/SQUARE|각관/.test(n)?r.squareTubePerM:r.pipePerM)); if(/BEARING/.test(n)) return r.bearingDefault; if(/MOTOR/.test(n)) return r.motorDefault; if(/SENSOR/.test(n)) return r.sensorDefault; return r.defaultUnit; }

function initViewer(){
  const el=document.getElementById('viewer');
  state.scene=new THREE.Scene(); state.scene.background=new THREE.Color(0x111827);
  state.camera=new THREE.PerspectiveCamera(45, el.clientWidth/el.clientHeight, 0.1, 100000);
  state.camera.position.set(240,220,260);
  state.renderer=new THREE.WebGLRenderer({antialias:true}); state.renderer.setPixelRatio(Math.min(devicePixelRatio,2)); state.renderer.setSize(el.clientWidth, el.clientHeight); el.appendChild(state.renderer.domElement);
  state.controls=new THREE.OrbitControls(state.camera, state.renderer.domElement); state.controls.enableDamping=true;
  state.scene.add(new THREE.AmbientLight(0xffffff,.75)); const dir=new THREE.DirectionalLight(0xffffff,.9); dir.position.set(200,300,400); state.scene.add(dir);
  const grid=new THREE.GridHelper(600,20,0x334155,0x1f2937); state.scene.add(grid);
  window.addEventListener('resize',()=>{ const w=el.clientWidth,h=el.clientHeight; state.camera.aspect=w/h; state.camera.updateProjectionMatrix(); state.renderer.setSize(w,h); });
  animate();
}
function animate(){ requestAnimationFrame(animate); state.controls?.update(); state.renderer?.render(state.scene,state.camera); }
function clearScene(){ if(state.allGroup){ state.scene.remove(state.allGroup); state.allGroup=null; } state.partObjects.clear(); }
function buildSceneFromParts(parts){
  clearScene(); const group=new THREE.Group(); state.allGroup=group; state.scene.add(group);
  parts.forEach((p,idx)=>{
    const obj=new THREE.Group(); obj.name=p.name;
    p.source.meshes.forEach(mesh=>{
      const geo=meshToGeometry(mesh); if(!geo) return;
      const color=mesh.color ? new THREE.Color(mesh.color[0],mesh.color[1],mesh.color[2]) : new THREE.Color().setHSL((idx*0.137)%1,.45,.62);
      const mat=new THREE.MeshStandardMaterial({color, metalness:.15, roughness:.65, side:THREE.DoubleSide});
      const m=new THREE.Mesh(geo,mat); obj.add(m);
    });
    group.add(obj); state.partObjects.set(p.id,obj);
  });
  fitCameraToObject(group);
}
function meshToGeometry(mesh){
  const pos=mesh?.attributes?.position?.array || []; const ind=flatten(mesh?.index?.array || []); if(!pos.length||!ind.length) return null;
  const geo=new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos,3)); geo.setIndex(ind); geo.computeVertexNormals(); geo.computeBoundingBox(); return geo;
}
function selectPart(id){
  state.selectedId=id; document.querySelectorAll('.parts-row').forEach(r=>r.classList.toggle('active',r.dataset.id===id));
  state.partObjects.forEach((obj,pid)=>{ obj.visible = pid===id; });
  const part=state.parts.find(p=>p.id===id); if(part){ document.getElementById('viewerLabel').textContent=part.name; fitCameraToObject(state.partObjects.get(id)); renderSelected(part); }
}
function showAllParts(){ state.partObjects.forEach(o=>o.visible=true); state.selectedId=null; document.getElementById('viewerLabel').textContent='전체 어셈블리 보기'; fitCameraToObject(state.allGroup); renderSelected(null); document.querySelectorAll('.parts-row').forEach(r=>r.classList.remove('active')); }
function fitCameraToObject(obj){ if(!obj) return; const box=new THREE.Box3().setFromObject(obj); if(!isFinite(box.min.x)) return; const size=box.getSize(new THREE.Vector3()); const center=box.getCenter(new THREE.Vector3()); const maxDim=Math.max(size.x,size.y,size.z)||100; const dist=maxDim*2.2; state.camera.position.set(center.x+dist, center.y+dist*.8, center.z+dist); state.camera.near=Math.max(0.1, maxDim/1000); state.camera.far=dist*10+maxDim*10; state.camera.updateProjectionMatrix(); state.controls.target.copy(center); state.controls.update(); }

function renderPartsTable(){
  const body=document.getElementById('partsBody'); body.innerHTML='';
  if(!state.parts.length){ body.innerHTML='<tr><td colspan="10" class="empty">실제 STEP mesh가 있는 말단 파트가 없습니다.</td></tr>'; return; }
  state.parts.forEach(p=>{
    const tr=document.createElement('tr'); tr.className='parts-row'; tr.dataset.id=p.id; tr.addEventListener('click',e=>{ if(['SELECT','INPUT'].includes(e.target.tagName)) return; selectPart(p.id); });
    tr.innerHTML = `
      <td><b>${escapeHtml(p.name)}</b><div class="mini">${escapeHtml(p.path||'')}</div></td>
      <td><input class="num" type="number" min="1" value="${p.qty}" data-field="qty"></td>
      <td>${recPill(p.recommendation)}</td>
      <td>${selectHtml('process', PROCESS_LIST, p.process)}</td>
      <td>${selectHtml('material', MATERIAL_LIST, p.material)}</td>
      <td><input class="num" type="number" step="0.1" value="${round1(p.thickness||0)}" data-field="thickness"></td>
      <td><input class="num" type="number" min="0" value="${p.tapCount||0}" data-field="tapCount"></td>
      <td><input class="num" type="number" min="0" value="${p.bendCount||0}" data-field="bendCount"></td>
      <td><input class="num" type="number" min="0" value="${p.margin||0}" data-field="margin"></td>
      <td class="money">${money(p.quote)}</td>`;
    tr.querySelectorAll('input,select').forEach(inp=>inp.addEventListener('change',()=>{ applyCellEdit(p, inp); calculateQuote(p); renderPartsTable(); renderSummary(); renderSelected(state.parts.find(x=>x.id===state.selectedId)); }));
    body.appendChild(tr);
  });
}
function recPill(rec){ const cls=rec.score>=85?'ok':rec.score>=65?'warn':'bad'; return `<span class="pill ${cls}">${rec.process} · ${rec.confidence}</span><div class="mini">${rec.reasons.slice(0,2).join(', ')}</div>`; }
function selectHtml(field, list, value){ return `<select data-field="${field}">${list.map(x=>`<option ${x===value?'selected':''}>${x}</option>`).join('')}</select>`; }
function applyCellEdit(p, inp){ const f=inp.dataset.field; let v=inp.value; if(['qty','thickness','tapCount','bendCount','margin'].includes(f)) v=+v||0; p[f]=v; }
function renderSummary(meta={}){ const total=state.parts.reduce((s,p)=>s+(p.quote||0),0); document.getElementById('partCount').textContent=state.parts.length; document.getElementById('asmCount').textContent=meta.asmCount ?? document.getElementById('asmCount').textContent ?? '0'; document.getElementById('totalQuote').textContent=money(total); }
function renderSelected(p){
  const el=document.getElementById('selectedInfo'); if(!p){ el.textContent='파트를 선택하세요.'; return; }
  const g=p.geom, f=p.feature;
  el.innerHTML = `
    <div class="kv"><b>파트명</b><span>${escapeHtml(p.name)}</span></div>
    <div class="kv"><b>공법</b><span>${p.process}</span></div>
    <div class="kv"><b>크기</b><span>${round1(g.dims.x)} × ${round1(g.dims.y)} × ${round1(g.dims.z)} mm</span></div>
    <div class="kv"><b>부피/면적</b><span>${Math.round(g.volumeMm3/1000).toLocaleString()} cm³ / ${Math.round(g.surfaceMm2/100).toLocaleString()} cm²</span></div>
    <div class="kv"><b>두께판단</b><span>${f.sheetLike ? '판재형' : '비판재/불확실'} · ${round1(g.thickness||0)}T</span></div>
    <div class="kv"><b>절곡 후보</b><span>${f.bendCandidates.length}개 ${f.bendCandidates.length ? f.bendCandidates.map(b=>`${b.length}mm`).join(', ') : '(자동 0회)'}</span></div>
    <div class="kv"><b>탭/홀</b><span>탭 ${p.tapCount||0} / 홀 후보 ${f.holeCount||0}</span></div>
    <div class="kv"><b>추천근거</b><span>${p.recommendation.reasons.join('<br>')}</span></div>
    <div class="kv"><b>산출</b><span>${p.costLines.map(x=>`${x[0]} ${money(x[1])}`).join('<br>')}<br><b>합계 ${money(p.quote)}</b></span></div>`;
}
function renderRateEditors(){
  const m=document.getElementById('marginEditor'); m.innerHTML=''; Object.keys(state.rates.margins).forEach(k=>{ const row=document.createElement('div'); row.className='rate-row'; row.innerHTML=`<label>${k}</label><input type="number" value="${state.rates.margins[k]}">`; row.querySelector('input').addEventListener('change',e=>{ state.rates.margins[k]=+e.target.value||0; state.parts.forEach(p=>{ if(p.process===k) p.margin=state.rates.margins[k]; }); recalcAll(); renderPartsTable(); }); m.appendChild(row); });
  const mat=document.getElementById('materialEditor'); mat.innerHTML=''; Object.entries(state.rates.materials).forEach(([k,v])=>{ const row=document.createElement('div'); row.className='rate-row'; row.innerHTML=`<label>${k}<div class="mini">${v.mode==='percent'?'시세+'+v.add+'%':v.mode==='fixed'?'시세+'+v.add+'원':'직접입력'}</div></label><input type="number" value="${Math.round(materialRate(k))}">`; row.querySelector('input').addEventListener('change',e=>{ v.mode='direct'; v.add=+e.target.value||0; recalcAll(); renderPartsTable(); }); mat.appendChild(row); });
}
function exportCsv(){
  const rows=[['파트명','수량','추천','공법','재질','두께','탭','절곡','마진','견적가']]; state.parts.forEach(p=>rows.push([p.name,p.qty,p.recommendation.process,p.process,p.material,p.thickness,p.tapCount,p.bendCount,p.margin,Math.round(p.quote)]));
  const csv='\ufeff'+rows.map(r=>r.map(x=>`"${String(x).replace(/"/g,'""')}"`).join(',')).join('\n'); const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='step_quote_parts.csv'; a.click(); URL.revokeObjectURL(a.href);
}
function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
