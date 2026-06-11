'use strict';

const DEFAULT_RATES = {
  materialMarket: {
    AL6061: { base: 6500, mode: 'percent', add: 18, density: 2.70 },
    SUS304: { base: 5200, mode: 'percent', add: 25, density: 7.93 },
    SS400: { base: 1450, mode: 'percent', add: 20, density: 7.85 },
    POM: { base: 8500, mode: 'fixed', add: 0, density: 1.41 },
    ABS: { base: 3800, mode: 'percent', add: 25, density: 1.04 },
    PLA: { base: 3200, mode: 'percent', add: 30, density: 1.24 }
  },
  processMargin: { 'CNC/MCT':22, '선반':20, '판금/절곡':18, '3D프린팅':28, '사출':18, '프로파일/압출':15, '용접':22, '구매품':10 },
  baseProcess: {
    'CNC/MCT': { small:45000, medium:95000, large:180000, complexityMid:0.18, complexityHigh:0.38, hole:700, tapM3:1500, tapM4:1800, tapM5:2000, tapM6:2500, tapM8:3500, tapM10:5000, tapM12:7000, setup:35000 },
    '선반': { small:35000, medium:80000, large:150000, groove:6000, setup:25000 },
    '판금/절곡': { base:25000, cutBase:12000, bendUnder1:1200, bend1to2:2200, bend2to32:3500, bend32to6:6000, hole:350, tap:1300, setup:20000 },
    '3D프린팅': { perCm3:230, supportRate:0.15, finish:8000, setup:5000 },
    '사출': { moldSimple:0, moldNormal:0, moldComplex:0, unitShot:120, finishUnit:40, setup:0 },
    '프로파일/압출': { profile2020:5500, profile3030:8000, profile4040:12000, profile4080:22000, cut:900, tap:1200, bracket:1200, setup:10000 },
    '용접': { base:40000, perJoint:6500, grinding:15000, setup:25000 },
    '구매품': { defaultUnit:5000, pipeMeter:9000, tubeMeter:8500, boltUnit:180, bearingUnit:9000, sensorUnit:35000 }
  }
};

const state = { parts: [], selectedId: null, rates: structuredClone(DEFAULT_RATES), sourceText: '' };

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n || 0).toLocaleString('ko-KR') + '원';
const cleanName = (s) => (s || '').replace(/\\'/g,"'").replace(/\s+/g,' ').trim();
const upper = (s) => (s || '').toUpperCase();

init();
function init(){
  setupUpload();
  renderRates();
  bindButtons();
}

function setupUpload(){
  const dz = $('dropZone');
  const input = $('fileInput');
  dz.addEventListener('dragover', e=>{e.preventDefault(); dz.classList.add('drag')});
  dz.addEventListener('dragleave', ()=>dz.classList.remove('drag'));
  dz.addEventListener('drop', e=>{e.preventDefault(); dz.classList.remove('drag'); if(e.dataTransfer.files[0]) readStepFile(e.dataTransfer.files[0]);});
  input.addEventListener('change', e=>{ if(e.target.files[0]) readStepFile(e.target.files[0]); });
}

function bindButtons(){
  $('recalcBtn').onclick = ()=>{ recalcAll(); renderParts(); renderSummary(); };
  $('applyAl').onclick = ()=>bulkApplyMaterial('AL6061');
  $('applySus').onclick = ()=>bulkApplyMaterial('SUS304');
  $('csvBtn').onclick = exportCsv;
  $('checkAll').onchange = (e)=> document.querySelectorAll('.row-check').forEach(c=>c.checked=e.target.checked);
}

function readStepFile(file){
  $('statParse').textContent = '읽는 중';
  const reader = new FileReader();
  reader.onerror = () => { $('statParse').textContent = '읽기 실패'; alert('파일을 읽지 못했습니다.'); };
  reader.onload = () => {
    const text = String(reader.result || '');
    state.sourceText = text;
    const parsed = StepTextParser.parse(text, file.name);
    state.parts = parsed.parts.map(enrichPart);
    recalcAll();
    renderParts();
    renderSummary(parsed);
    $('statParse').textContent = parsed.parts.length ? '완료' : '파트 없음';
    if (!parsed.parts.length) {
      $('warning').textContent = 'STEP 텍스트에서 PRODUCT/Assembly/BREP 이름을 찾지 못했습니다. 파일이 바이너리/압축/암호화되었거나 지원되지 않는 내보내기 형식일 수 있습니다.';
    } else {
      $('warning').textContent = `분석 완료: 어셈블리/서브어셈블리 ${parsed.assemblyExcluded}개 제외, 말단 파트 ${parsed.parts.length}개 표시. 자동값은 먼저 채워지고 공장이 수정합니다.`;
    }
  };
  reader.readAsText(file);
}

const StepTextParser = {
  parse(text, filename){
    const normalized = text.replace(/\r/g,'');
    const entities = parseStepEntities(normalized);
    const products = new Map();
    const formations = new Map();
    const definitions = new Map();
    const parentDefs = new Set();
    const childDefs = new Set();
    const occurrences = [];
    const breps = [];

    for(const [id, body] of entities){
      const type = getEntityType(body);
      const args = body.slice(body.indexOf('(')+1, body.lastIndexOf(')'));
      if(type === 'PRODUCT'){
        const strings = extractStrings(args);
        products.set(id, { id, code: cleanName(strings[0]), name: cleanName(strings[1] || strings[0] || `PRODUCT_${id}`) });
      } else if(type === 'PRODUCT_DEFINITION_FORMATION' || type === 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE'){
        const refs = extractRefs(args);
        const prodRef = refs.find(r => products.has(r));
        if(prodRef) formations.set(id, prodRef);
      } else if(type === 'PRODUCT_DEFINITION'){
        const refs = extractRefs(args);
        const formRef = refs.find(r => formations.has(r));
        if(formRef) definitions.set(id, formations.get(formRef));
      } else if(type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE'){
        const refs = extractRefs(args);
        const strings = extractStrings(args);
        if(refs.length >= 2){
          const parent = refs[refs.length-2];
          const child = refs[refs.length-1];
          parentDefs.add(parent); childDefs.add(child);
          occurrences.push({ id, parent, child, name: cleanName(strings[1] || strings[0] || '') });
        }
      } else if(type.includes('MANIFOLD_SOLID_BREP') || type.includes('BREP_WITH_VOIDS')){
        const strings = extractStrings(args);
        breps.push({ id, name: cleanName(strings[0] || `BREP_${id}`) });
      }
    }

    let rawLeaf = [];
    const leafDefIds = [...childDefs].filter(d => !parentDefs.has(d));
    if(leafDefIds.length){
      rawLeaf = leafDefIds.map(defId => {
        const prodRef = definitions.get(defId);
        const prod = products.get(prodRef) || { name: `PART_${defId}` };
        const occNames = occurrences.filter(o=>o.child===defId).map(o=>o.name).filter(Boolean);
        return { name: chooseBestName([prod.name, prod.code, ...occNames]), source:'assembly-leaf' };
      });
    } else if(products.size){
      rawLeaf = [...products.values()].map(p => ({ name: chooseBestName([p.name, p.code]), source:'product' }));
    } else if(breps.length){
      rawLeaf = breps.map(b => ({ name:b.name, source:'brep' }));
    }

    rawLeaf = rawLeaf.filter(p => !isAssemblyName(p.name));
    if(!rawLeaf.length && products.size){
      rawLeaf = [...products.values()].map(p => ({ name: chooseBestName([p.name,p.code]), source:'product-fallback' }));
    }

    const grouped = new Map();
    for(const p of rawLeaf){
      const key = normalizePartKey(p.name || filename.replace(/\.(stp|step)$/i,''));
      if(!key || isAssemblyName(key)) continue;
      if(!grouped.has(key)) grouped.set(key, { id:'P'+(grouped.size+1), name:key, qty:0, sources:[] });
      const g = grouped.get(key); g.qty += 1; g.sources.push(p.source);
    }

    const parts = [...grouped.values()];
    return { parts, assemblyExcluded: Math.max(0, parentDefs.size || countAssemblyLikeProducts(products)), entityCount: entities.size };
  }
};

function parseStepEntities(text){
  const map = new Map();
  let i=0;
  while(i < text.length){
    const hash = text.indexOf('#', i);
    if(hash < 0) break;
    let j = hash+1;
    while(j<text.length && /\d/.test(text[j])) j++;
    if(text[j] !== '='){ i=j; continue; }
    const id = text.slice(hash, j);
    let k = j+1, depth=0, inStr=false;
    for(; k<text.length; k++){
      const ch = text[k];
      if(ch === "'"){
        if(text[k+1] === "'"){ k++; continue; }
        inStr = !inStr;
      } else if(!inStr){
        if(ch === '(') depth++;
        else if(ch === ')') depth = Math.max(0, depth-1);
        else if(ch === ';' && depth === 0) break;
      }
    }
    map.set(id, text.slice(j+1,k).trim());
    i = k+1;
  }
  return map;
}
function getEntityType(body){ return (body.match(/^([A-Z0-9_]+)/i)||['','UNKNOWN'])[1].toUpperCase(); }
function extractStrings(args){
  const out=[]; let i=0;
  while(i<args.length){
    if(args[i] !== "'"){i++; continue;}
    let j=i+1, s='';
    while(j<args.length){
      if(args[j]==="'" && args[j+1]==="'"){s+="'"; j+=2; continue;}
      if(args[j]==="'") break;
      s += args[j++];
    }
    out.push(cleanName(s)); i=j+1;
  }
  return out;
}
function extractRefs(args){ return [...args.matchAll(/#\d+/g)].map(m=>m[0]); }
function chooseBestName(names){
  const clean = names.map(cleanName).filter(Boolean).filter(n=>!/^\$|\*$/i.test(n));
  clean.sort((a,b)=> scoreName(b)-scoreName(a));
  return clean[0] || 'UNNAMED_PART';
}
function scoreName(n){
  let s = Math.min(n.length, 40);
  if(/[A-Z가-힣]/i.test(n)) s += 5;
  if(/PART|PLATE|BRACKET|PIPE|SHAFT|FRAME|COVER|BLOCK|BASE|BOLT|TUBE|PROFILE/i.test(n)) s += 20;
  if(/ASSEMBLY|ASSY|ASM|조립/i.test(n)) s -= 50;
  return s;
}
function normalizePartKey(n){ return cleanName(n).replace(/^PRODUCT\s*/i,'').replace(/\.(SLDPRT|PRT|STEP|STP)$/i,'').replace(/\s*<[^>]+>\s*/g,'').trim() || 'UNNAMED_PART'; }
function isAssemblyName(n){ return /(^|[_\-\s])(ASM|ASSY|ASSEMBLY|SUBASM|SUB_ASSY|조립|어셈|ASSEMBLAGE)([_\-\s]|$)/i.test(n||''); }
function countAssemblyLikeProducts(products){ return [...products.values()].filter(p=>isAssemblyName(p.name)||isAssemblyName(p.code)).length; }

function enrichPart(raw){
  const f = estimateFeatures(raw.name, raw.qty);
  const cls = classifyPart(raw.name, f);
  const material = cls.process === '구매품' ? '-' : (cls.process === '판금/절곡' ? 'SUS304' : cls.process === '3D프린팅' ? 'ABS' : 'AL6061');
  return { ...raw, features:f, recommendation:cls, process:cls.process, material, margin: state.rates.processMargin[cls.process] ?? 20, tapCount:f.tapCandidates, bendCount:f.bendCandidates, unitPrice:0, totalPrice:0, checked:false };
}

function estimateFeatures(name, qty){
  const n = upper(name);
  const dims = parseDims(n);
  const thickness = parseThickness(n) || inferThickness(n);
  const length = parseLength(n) || dims.length || 100;
  const width = dims.width || inferWidth(n);
  const height = dims.height || thickness || inferHeight(n);
  const isPipe = /PIPE|TUBE|각관|파이프|배관|SQUARE[_\-\s]?TUBE|ROUND[_\-\s]?TUBE/i.test(n);
  const isProfile = !isPipe && /(PROFILE|AL[_\-\s]?FRAME|프로파일|2020|3030|4040|4080|4545|6060|8080)/i.test(n);
  const isHardware = /BOLT|NUT|WASHER|BEARING|SENSOR|MOTOR|CYLINDER|SCREW|LM|GUIDE_RAIL|COUPLING|GEAR|PULLEY|체결|볼트|너트|베어링/i.test(n);
  const isRotary = /SHAFT|PIN|BUSH|BUSHING|ROLLER|COLLAR|SPACER|축|샤프트|핀|부시/i.test(n);
  const bendHint = /BEND|BENT|FOLD|FLANGE|L_BRACKET|U_BRACKET|절곡|접힘/i.test(n);
  const sheetHint = /SHEET|PANEL|COVER|BRACKET|PLATE|판금|커버|브라켓|판넬|패널/i.test(n);
  const cncHint = /BASE|BLOCK|JIG|FIXTURE|MOUNT|HOLDER|SUPPORT|ADAPTER|CLAMP|GUIDE|PLATE|금형|지그|베이스/i.test(n);
  const pocketHint = /POCKET|SLOT|GROOVE|COUNTER|CBORE|자리파기|홈|포켓/i.test(n);
  const tapHint = /(M3|M4|M5|M6|M8|M10|M12|TAP|탭)/i.test(n);
  const holeHint = /(HOLE|홀|Ø|D\d+)/i.test(n);

  const sheetLike = !!(sheetHint && thickness && thickness <= 6 && !isPipe && !isProfile && !isHardware && !isRotary);
  const constantThickness = sheetLike ? 0.86 : (cncHint ? 0.45 : 0.6);
  const bendCandidates = (sheetLike && bendHint) ? inferBendCount(n) : 0;
  const tapCandidates = tapHint ? inferTapCount(n) : (cncHint && holeHint ? 4 : 0);
  const holeCandidates = holeHint ? inferHoleCount(n) : (tapCandidates ? tapCandidates : 0);
  const volumeCm3 = Math.max(1, (length * width * height) / 1000 * (sheetLike ? 0.32 : isPipe ? 0.18 : isProfile ? 0.22 : 0.65));

  return { length, width, height, thickness, isPipe, isProfile, isHardware, isRotary, bendHint, sheetHint, cncHint, pocketHint, tapHint, holeHint, sheetLike, constantThickness, bendCandidates, tapCandidates, holeCandidates, volumeCm3, sizeClass: length*width*height < 500000 ? 'small' : length*width*height < 3000000 ? 'medium' : 'large' };
}
function parseDims(n){
  const m = n.match(/(\d+(?:\.\d+)?)\s*[X×]\s*(\d+(?:\.\d+)?)(?:\s*[X×]\s*(\d+(?:\.\d+)?))?/i);
  if(m) return { length:+m[1], width:+m[2], height:m[3]?+m[3]:undefined };
  return {};
}
function parseThickness(n){ const m=n.match(/(?:^|[^A-Z0-9])(?:T|THK|두께)\s*([0-9]+(?:\.[0-9]+)?)/i)||n.match(/([0-9]+(?:\.[0-9]+)?)\s*T(?:[^A-Z0-9]|$)/i); return m?+m[1]:0; }
function parseLength(n){ const m=n.match(/(?:^|[^A-Z])L\s*([0-9]+(?:\.[0-9]+)?)/i)||n.match(/([0-9]+(?:\.[0-9]+)?)\s*MM/i); return m?+m[1]:0; }
function inferThickness(n){ if(/PLATE|BASE/i.test(n)) return 12; if(/COVER|PANEL|SHEET|BRACKET/i.test(n)) return 2; return 8; }
function inferWidth(n){ if(/PIPE|TUBE/i.test(n)) return 30; if(/PROFILE|4040/i.test(n)) return 40; if(/3030/i.test(n)) return 30; if(/2020/i.test(n)) return 20; return 80; }
function inferHeight(n){ if(/PIPE|TUBE/i.test(n)) return 30; if(/PROFILE|4040/i.test(n)) return 40; if(/3030/i.test(n)) return 30; if(/2020/i.test(n)) return 20; return 20; }
function inferBendCount(n){ if(/U_BRACKET|U[_\-\s]?BEND|ㄷ/i.test(n)) return 2; if(/BOX|CASE/i.test(n)) return 4; if(/L_BRACKET|L[_\-\s]?BEND|FLANGE|ㄱ/i.test(n)) return 1; return 1; }
function inferTapCount(n){ const m=n.match(/(?:TAP|탭).*?(\d+)/i)||n.match(/(\d+)\s*(?:EA|개).*?(?:TAP|탭)/i); return m?Math.min(99,+m[1]):2; }
function inferHoleCount(n){ const m=n.match(/(?:HOLE|홀).*?(\d+)/i)||n.match(/(\d+)\s*(?:EA|개).*?(?:HOLE|홀)/i); return m?Math.min(99,+m[1]):4; }

function classifyPart(name, f){
  const reasons=[];
  if(f.isHardware || f.isPipe){ reasons.push(f.isPipe?'파이프/튜브/각관은 표준 구매재 우선':'표준 구매품 이름'); return { process:'구매품', confidence:'높음', reasons }; }
  if(f.isProfile){ reasons.push('프로파일 규격/이름 감지'); return { process:'프로파일/압출', confidence:'높음', reasons }; }
  if(f.isRotary){ reasons.push('축/핀/부시 등 회전체 이름'); return { process:'선반', confidence:'보통', reasons }; }
  if(f.sheetLike){
    if(f.bendCandidates>0){ reasons.push('얇은 판재형 + 절곡/플랜지 힌트'); return { process:'판금/절곡', confidence:'보통', reasons }; }
    reasons.push('얇은 판재형이나 절곡은 불확실: 절곡 0회'); return { process:'판금/절곡', confidence:'낮음', reasons };
  }
  if(/ABS|PLA|RESIN|PRINT|3D|시제품/i.test(name)){ reasons.push('플라스틱/출력 힌트'); return { process:'3D프린팅', confidence:'보통', reasons }; }
  if(f.cncHint || f.pocketHint || f.tapCandidates || f.holeCandidates){ reasons.push('구매품/프로파일/선반/판금 제외 후 절삭 특징'); return { process:'CNC/MCT', confidence:f.pocketHint?'높음':'보통', reasons }; }
  return { process:'분류 필요', confidence:'낮음', reasons:['명확한 공법 힌트 부족'] };
}

function calcPart(p){
  const rates = state.rates;
  const qty = Math.max(1, +p.qty || 1);
  const process = p.process;
  const f = p.features;
  let materialCost = 0, processCost = 0;
  const weightKg = estimateWeightKg(p);
  if(p.material && p.material !== '-') materialCost = materialUnitCost(p.material) * weightKg * qty;
  const r = rates.baseProcess[process] || rates.baseProcess['구매품'];
  if(process === 'CNC/MCT'){
    processCost = (r[f.sizeClass] || r.medium) * qty + r.setup + (p.tapCount||0) * r.tapM6 * qty + (f.holeCandidates||0) * r.hole * qty;
    if(f.pocketHint) processCost *= 1.18;
  } else if(process === '선반'){
    processCost = (r[f.sizeClass] || r.medium) * qty + r.setup;
  } else if(process === '판금/절곡'){
    const bendUnit = bendRateByThickness(f.thickness, r);
    processCost = (r.base + r.cutBase) * qty + (p.bendCount||0) * bendUnit * qty + (f.holeCandidates||0)*r.hole*qty + (p.tapCount||0)*r.tap*qty + r.setup;
  } else if(process === '3D프린팅'){
    processCost = f.volumeCm3 * r.perCm3 * qty + r.finish * qty + r.setup;
  } else if(process === '사출'){
    processCost = r.unitShot * qty + r.finishUnit * qty; // 초기 기본: 금형비 자동 포함 안 함
  } else if(process === '프로파일/압출'){
    const meter = Math.max(0.05, f.length/1000);
    const profileRate = /4080/.test(upper(p.name)) ? r.profile4080 : /3030/.test(upper(p.name)) ? r.profile3030 : /2020/.test(upper(p.name)) ? r.profile2020 : r.profile4040;
    processCost = meter * profileRate * qty + r.cut * qty + r.setup;
  } else if(process === '용접'){
    processCost = r.base + r.perJoint * Math.max(1, qty) + r.grinding;
  } else if(process === '구매품'){
    if(f.isPipe) processCost = Math.max(0.05, f.length/1000) * r.pipeMeter * qty;
    else if(/BEARING/i.test(p.name)) processCost = r.bearingUnit * qty;
    else if(/SENSOR/i.test(p.name)) processCost = r.sensorUnit * qty;
    else if(/BOLT|NUT|WASHER|SCREW/i.test(p.name)) processCost = r.boltUnit * qty;
    else processCost = r.defaultUnit * qty;
  }
  const subtotal = materialCost + processCost;
  const margin = subtotal * ((+p.margin || 0)/100);
  p.unitPrice = (subtotal + margin) / qty;
  p.totalPrice = subtotal + margin;
}
function estimateWeightKg(p){
  const density = state.rates.materialMarket[p.material]?.density || 2.7;
  return (p.features.volumeCm3 * density) / 1000;
}
function materialUnitCost(mat){
  const m = state.rates.materialMarket[mat]; if(!m) return 0;
  if(m.mode === 'amount') return m.base + m.add;
  if(m.mode === 'percent') return m.base * (1 + m.add/100);
  return m.base;
}
function bendRateByThickness(t, r){ if(t<=1) return r.bendUnder1; if(t<=2) return r.bend1to2; if(t<=3.2) return r.bend2to32; return r.bend32to6; }
function recalcAll(){ state.parts.forEach(calcPart); }

function renderParts(){
  const body = $('partsBody');
  if(!state.parts.length){ body.innerHTML = '<tr><td colspan="11" class="empty">STEP 파일을 업로드하면 말단 파트가 표시됩니다.</td></tr>'; return; }
  body.innerHTML = state.parts.map(p=>`
    <tr data-id="${p.id}" class="${state.selectedId===p.id?'selected':''}">
      <td><input class="row-check" type="checkbox" data-id="${p.id}"></td>
      <td><div class="part-name">${escapeHtml(p.name)}</div><div class="reason">${p.recommendation.reasons.map(escapeHtml).join(' · ')}</div></td>
      <td><input type="number" min="1" value="${p.qty}" data-edit="qty" data-id="${p.id}"></td>
      <td><span class="tag ${p.recommendation.confidence==='낮음'?'bad':'ok'}">${p.recommendation.process} · ${p.recommendation.confidence}</span></td>
      <td>${selectProcess(p)}</td>
      <td>${selectMaterial(p)}</td>
      <td><input type="text" value="${p.features.thickness||''}T / L${Math.round(p.features.length)}" data-edit="spec" data-id="${p.id}"></td>
      <td><input type="number" min="0" value="${p.tapCount}" data-edit="tapCount" data-id="${p.id}"></td>
      <td><input type="number" min="0" value="${p.bendCount}" data-edit="bendCount" data-id="${p.id}"></td>
      <td><input type="number" min="0" value="${p.margin}" data-edit="margin" data-id="${p.id}"></td>
      <td class="price">${fmt(p.totalPrice)}</td>
    </tr>`).join('');
  body.querySelectorAll('tr[data-id]').forEach(tr=> tr.onclick = (e)=>{ if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT') return; selectPart(tr.dataset.id); });
  body.querySelectorAll('[data-edit]').forEach(el=> el.oninput = editHandler);
  body.querySelectorAll('select').forEach(el=> el.onchange = editHandler);
}
function selectProcess(p){ const opts=['분류 필요','CNC/MCT','선반','판금/절곡','3D프린팅','사출','프로파일/압출','용접','구매품','제외']; return `<select data-edit="process" data-id="${p.id}">${opts.map(o=>`<option ${o===p.process?'selected':''}>${o}</option>`).join('')}</select>`; }
function selectMaterial(p){ const opts=['-','AL6061','SUS304','SS400','POM','ABS','PLA']; return `<select data-edit="material" data-id="${p.id}">${opts.map(o=>`<option ${o===p.material?'selected':''}>${o}</option>`).join('')}</select>`; }
function editHandler(e){
  const p = state.parts.find(x=>x.id===e.target.dataset.id); if(!p) return;
  const k=e.target.dataset.edit;
  if(['qty','tapCount','bendCount','margin'].includes(k)) p[k]=+e.target.value||0;
  else if(k==='process'){ p.process=e.target.value; p.margin=state.rates.processMargin[p.process] ?? p.margin; }
  else if(k==='material') p.material=e.target.value;
  calcPart(p); renderParts(); selectPart(p.id); renderSummary();
}
function selectPart(id){ state.selectedId=id; const p=state.parts.find(x=>x.id===id); renderParts(); renderDetail(p); }
function renderDetail(p){
  if(!p){ $('partDetail').textContent='파트를 선택하세요.'; return; }
  $('partPreview').innerHTML = `<div class="mock-shape" style="width:${Math.min(230,80+p.features.length/2)}px;height:${Math.min(150,60+p.features.height*2)}px;border-radius:${p.process==='선반'||p.features.isPipe?'999px':'8px'}"></div>`;
  $('partDetail').innerHTML = `
    <b>${escapeHtml(p.name)}</b><br>
    공법: ${p.process} / 재질: ${p.material} / 수량: ${p.qty}<br>
    추정 크기: ${Math.round(p.features.length)} × ${Math.round(p.features.width)} × ${Math.round(p.features.height)}mm<br>
    두께: ${p.features.thickness}T / 탭: ${p.tapCount} / 절곡: ${p.bendCount}<br>
    추천 근거: ${p.recommendation.reasons.map(escapeHtml).join(', ')}<br>
    파트 견적: <b>${fmt(p.totalPrice)}</b>`;
}
function renderSummary(parsed){
  const total = state.parts.reduce((s,p)=>s+(p.process==='제외'?0:p.totalPrice),0);
  $('statLeaf').textContent = state.parts.length;
  $('statAssembly').textContent = parsed?.assemblyExcluded ?? $('statAssembly').textContent;
  $('statTotal').textContent = fmt(total);
}
function renderRates(){
  const f = $('ratesForm');
  const margins = state.rates.processMargin;
  f.innerHTML = Object.keys(margins).map(k=>`<div class="rate-row"><label>${k} 마진%</label><input type="number" value="${margins[k]}" data-rate="${k}"></div>`).join('');
  f.querySelectorAll('[data-rate]').forEach(inp=> inp.oninput = e=>{ state.rates.processMargin[e.target.dataset.rate]=+e.target.value||0; state.parts.forEach(p=>{ if(p.process===e.target.dataset.rate) p.margin=+e.target.value||0; }); recalcAll(); renderParts(); renderSummary(); });
}
function bulkApplyMaterial(mat){
  document.querySelectorAll('.row-check:checked').forEach(c=>{ const p=state.parts.find(x=>x.id===c.dataset.id); if(p && p.process!=='구매품') {p.material=mat; calcPart(p);} });
  renderParts(); renderSummary();
}
function exportCsv(){
  const rows=[['파트명','수량','공법','재질','탭','절곡','마진','견적가']].concat(state.parts.map(p=>[p.name,p.qty,p.process,p.material,p.tapCount,p.bendCount,p.margin,Math.round(p.totalPrice)]));
  const csv='\ufeff'+rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})); a.download='step_quote_parts.csv'; a.click(); URL.revokeObjectURL(a.href);
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
