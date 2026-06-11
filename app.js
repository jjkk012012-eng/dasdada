'use strict';

const AppState = {
  parts: [],
  selectedId: null,
  rates: null,
  fileName: '',
};

const DEFAULT_RATES = {
  materials: {
    AL6061: { market: 6200, mode: 'percent', add: 18, density: 2.70 },
    SUS304: { market: 4700, mode: 'percent', add: 25, density: 7.93 },
    SS400: { market: 1250, mode: 'fixed', add: 650, density: 7.85 },
    POM: { market: 7200, mode: 'direct', add: 7200, density: 1.41 },
    ABS: { market: 3200, mode: 'direct', add: 3200, density: 1.04 },
    PP: { market: 2100, mode: 'direct', add: 2100, density: 0.90 },
  },
  processMargins: { 'CNC/MCT': 22, '선반': 20, '판금/절곡': 18, '3D프린팅': 28, '사출': 18, '프로파일/압출': 15, '용접': 22, '구매품': 10, '제외': 0, '분류 필요': 0 },
  cnc: { small: 42000, medium: 85000, large: 160000, setup: 35000, pocket: 12000, step: 7000, hole: 800, tabBase: { M3: 1200, M4: 1500, M5: 1800, M6: 2200, M8: 3200, M10: 4800, M12: 6200 }, blindFactor: 1.35, deepFactor: 1.75, susFactor: 1.25 },
  lathe: { small: 30000, medium: 65000, large: 120000, groove: 5000, thread: 8000 },
  sheet: { base: 28000, cutPerM: 1400, hole: 400, tab: 1300, bendSetup: 25000, bendByThickness: [{ max: 1.0, price: 1300 }, { max: 2.0, price: 2200 }, { max: 3.2, price: 3600 }, { max: 6.0, price: 6500 }], susFactor: 1.25, alFactor: 1.1, longFactors: [{ max: 300, factor: 1 }, { max: 800, factor: 1.18 }, { max: 1500, factor: 1.45 }, { max: 99999, factor: 1.9 }] },
  printing: { fdmCm3: 260, slaCm3: 780, supportFactor: 1.18, finish: 12000 },
  injection: { moldSimple: 2500000, moldNormal: 4200000, moldComplex: 6500000, unit: 80, moldDefaultIncluded: false },
  profile: { m2020: 6500, m3030: 8500, m4040: 12500, m4080: 23000, cut: 800, tab: 1300, bracket: 1200 },
  weld: { base: 30000, per100mm: 4500, finish: 15000 },
  assembly: { simple: 50000, normal: 120000, complex: 250000, inspection: 40000, packing: 25000 },
  purchase: { defaultUnit: 2500, pipePerM: 18000, squareTubePerM: 21000, bearingDefault: 9000, motorDefault: 45000, sensorDefault: 22000 }
};

const PROCESS_LIST = ['구매품','프로파일/압출','선반','판금/절곡','CNC/MCT','3D프린팅','사출','용접','분류 필요','제외'];
const MATERIAL_LIST = ['AL6061','SUS304','SS400','POM','ABS','PP'];

function money(v) { return Math.round(v || 0).toLocaleString('ko-KR') + '원'; }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function safeUpper(s) { return (s || '').toString().toUpperCase(); }
function uniqueId(prefix='p') { return prefix + '_' + Math.random().toString(36).slice(2,10); }

window.addEventListener('DOMContentLoaded', async () => {
  AppState.rates = await loadRates();
  renderRateEditor();
  bindEvents();
});

async function loadRates() {
  try {
    const res = await fetch('data/rates.json', { cache: 'no-store' });
    if (res.ok) {
      const json = await res.json();
      return deepMerge(DEFAULT_RATES, json.runtimeRates || json);
    }
  } catch (e) {}
  return structuredClone(DEFAULT_RATES);
}

function deepMerge(a,b){
  if(!b || typeof b !== 'object') return structuredClone(a);
  const out = Array.isArray(a) ? [...a] : { ...a };
  for(const k of Object.keys(b)){
    if(b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k]) out[k] = deepMerge(a[k], b[k]);
    else out[k] = b[k];
  }
  return out;
}

function bindEvents(){
  const input = document.getElementById('fileInput');
  input.addEventListener('change', e => handleFile(e.target.files[0]));
  const dz = document.getElementById('dropzone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); handleFile(e.dataTransfer.files[0]); });
  document.getElementById('recalcAll').addEventListener('click', () => { recalcAll(); renderParts(); renderSummary(); });
  document.getElementById('applyMaterial').addEventListener('click', () => { selectedParts().forEach(p => p.material = 'AL6061'); recalcAll(); renderParts(); renderSummary(); });
  document.getElementById('exportCsv').addEventListener('click', exportCsv);
}

async function handleFile(file){
  if(!file) return;
  AppState.fileName = file.name;
  setStatus('분석중');
  const text = await file.text();
  const parsed = StepAssemblyParser.parse(text, file.name);
  const leaves = LeafPartExtractor.extract(parsed);
  const withFeatures = leaves.map((p, idx) => {
    const feature = FeatureEstimator.estimate(p, idx, text.length);
    const classification = ProcessClassifier.classify({ ...p, feature });
    return QuotePart.fromParsed(p, feature, classification);
  });
  AppState.parts = mergeSameLeafParts(withFeatures);
  recalcAll();
  renderParts();
  renderSummary(parsed);
  setStatus('완료');
}

function setStatus(t){ document.getElementById('confidenceText').textContent = t; }

const StepAssemblyParser = {
  parse(text, fileName){
    const clean = text.replace(/\r/g,'');
    const entityMap = new Map();
    const lines = clean.match(/#\d+\s*=\s*[^;]+;/g) || [];
    for(const raw of lines){
      const id = raw.match(/^#(\d+)/)?.[1];
      if(id) entityMap.set('#'+id, raw);
    }
    const products = [];
    const productRe = /#(\d+)\s*=\s*PRODUCT\s*\(\s*'([^']*)'/gi;
    let m;
    while((m = productRe.exec(clean))){ products.push({ id:'#'+m[1], name: normalizeName(m[2]), raw:m[0] }); }

    const breps = [];
    const brepRe = /#(\d+)\s*=\s*(MANIFOLD_SOLID_BREP|BREP_WITH_VOIDS|SHELL_BASED_SURFACE_MODEL|GEOMETRIC_SET)\s*\(\s*'([^']*)'/gi;
    while((m = brepRe.exec(clean))){ breps.push({ id:'#'+m[1], name: normalizeName(m[3]), type:m[2] }); }

    const relations = [];
    const nauoRe = /#(\d+)\s*=\s*NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(([^;]+)\);/gi;
    while((m = nauoRe.exec(clean))){
      const refs = m[2].match(/#\d+/g) || [];
      relations.push({ id:'#'+m[1], refs, raw:m[2] });
    }

    const shapeReps = countMatches(clean, /SHAPE_REPRESENTATION\s*\(/g);
    const asmLike = countMatches(clean, /NEXT_ASSEMBLY_USAGE_OCCURRENCE\s*\(/g);
    const geometryStats = {
      circles: countMatches(clean, /CIRCLE\s*\(/g),
      planes: countMatches(clean, /PLANE\s*\(/g),
      cylinders: countMatches(clean, /CYLINDRICAL_SURFACE\s*\(/g),
      torus: countMatches(clean, /TOROIDAL_SURFACE\s*\(/g),
      bSpline: countMatches(clean, /B_SPLINE_SURFACE|B_SPLINE_CURVE/g),
      faces: countMatches(clean, /ADVANCED_FACE\s*\(/g),
      edgeLoops: countMatches(clean, /EDGE_LOOP\s*\(/g),
    };

    // If relationships are incomplete, use PRODUCT names and BREP names. Assembly containers are filtered later.
    return { fileName, products, breps, relations, shapeReps, asmLike, geometryStats, textSize: text.length };
  }
};

const LeafPartExtractor = {
  extract(parsed){
    const candidates = [];
    // BREP names are usually actual solids; products include containers too. Prefer BREP if present.
    if(parsed.breps.length){
      for(const b of parsed.breps){ candidates.push({ id:b.id, name:b.name || `PART_${b.id.slice(1)}`, source:'BREP', isAssembly:false }); }
    } else {
      for(const p of parsed.products){ candidates.push({ id:p.id, name:p.name || `PART_${p.id.slice(1)}`, source:'PRODUCT', isAssembly:false }); }
    }

    const filtered = candidates.filter(c => !NameRules.isAssemblyName(c.name));
    const good = filtered.length ? filtered : candidates;
    if(good.length) return good;
    // Fallback sample leaves if no names in file.
    return [
      { id:'#F1', name:'BASE_PLATE_20T', source:'FALLBACK' },
      { id:'#F2', name:'L_BRACKET_BENT_2T', source:'FALLBACK' },
      { id:'#F3', name:'PIPE_STS_D25_L500', source:'FALLBACK' },
      { id:'#F4', name:'PROFILE_4040_L800', source:'FALLBACK' },
    ];
  }
};

const NameRules = {
  isAssemblyName(name){
    const n=safeUpper(name);
    return /(^|[_\-\s])(ASM|ASSY|ASSEMBLY|SUBASM|SUB_ASSY|조립|어셈|전체|UNIT)([_\-\s]|$)/.test(n);
  },
  isPurchase(name){
    const n=safeUpper(name);
    return /(BOLT|NUT|WASHER|BEARING|SENSOR|MOTOR|CYLINDER|SCREW|SPRING|BALL|LM|GUIDE_RAIL|HINGE|HANDLE|KNOB|COUPLER|VALVE|FITTING|PIPE|TUBE|SQUARE_TUBE|ROUND_TUBE|각관|파이프|튜브|배관)/.test(n);
  },
  isProfile(name){
    const n=safeUpper(name);
    if(/PIPE|TUBE|각관|파이프|튜브/.test(n)) return false;
    return /(PROFILE|AL_PROFILE|ALFRAME|FRAME_?(2020|3030|4040|4080|4545|5050|6060)|(^|_)20X20|30X30|40X40|40X80)/.test(n);
  },
  isLathe(name){ return /(SHAFT|PIN|BUSH|BUSHING|ROLLER|SPACER_ROUND|COLLAR|AXIS|축|핀|부싱|롤러)/.test(safeUpper(name)); },
  hasBendHint(name){ return /(BEND|BENT|FOLD|FLANGE|HEM|L_BRACKET|U_BRACKET|Z_BRACKET|절곡|접힘|플랜지)/.test(safeUpper(name)); },
  sheetHint(name){ return /(COVER|PANEL|BRACKET|SHEET|PLATE_?[0-6](\.\d)?T|_1T|_1\.5T|_2T|_3T|_4T|_5T|_6T|커버|판넬|브라켓)/.test(safeUpper(name)); },
  cncHint(name){ return /(BASE|BLOCK|JIG|FIXTURE|MOUNT|HOLDER|SUPPORT|ADAPTER|CLAMP|GUIDE|PLATE|BRACKET|HOUSING|가공|지그|베이스)/.test(safeUpper(name)); },
  plasticHint(name){ return /(ABS|PP|POM|PC|CASE|COVER|HOUSING|CAP|PLASTIC|수지|플라스틱)/.test(safeUpper(name)); }
};

function normalizeName(s){ return (s || '').trim().replace(/\\X2\\|\\X0\\/g,'').replace(/\s+/g,'_').replace(/^_+|_+$/g,'') || 'UNNAMED_PART'; }
function countMatches(s,re){ return (s.match(re)||[]).length; }

const FeatureEstimator = {
  estimate(p, idx, textSize){
    const n = safeUpper(p.name);
    const dims = this.dimensionsFromName(n, idx);
    const thickness = this.thicknessFromName(n, dims);
    const sheetLikeName = NameRules.sheetHint(n);
    const bendHint = NameRules.hasBendHint(n);
    const isPipe = /PIPE|TUBE|각관|파이프|튜브/.test(n);
    const isProfile = NameRules.isProfile(n);
    const isLathe = NameRules.isLathe(n);

    const volumeCm3 = Math.max(1, (dims.x*dims.y*dims.z)/1000 * (sheetLikeName ? 0.22 : isPipe ? 0.12 : isProfile ? 0.18 : isLathe ? 0.55 : 0.42));
    const surfaceCm2 = Math.max(10, 2*(dims.x*dims.y + dims.y*dims.z + dims.x*dims.z)/100);
    const holeCount = this.holesFromName(n, idx, dims);
    const tapCandidates = this.tapCandidates(n, holeCount, thickness);
    const sheetScore = this.sheetScore(n, dims, thickness, sheetLikeName, isPipe, isProfile);
    const bendCandidates = BendAnalyzer.estimate({ name:n, dims, thickness, sheetScore, bendHint, isPipe, isProfile });
    const pocketCount = /POCKET|SLOT|자리|홈|카운터|COUNTER|CB/.test(n) ? 2 + (idx % 3) : (NameRules.cncHint(n) && !sheetLikeName ? idx % 2 : 0);
    const stepFaceCount = NameRules.cncHint(n) && !isProfile && !isPipe ? 2 + (idx % 4) : 0;
    const rotational = isLathe || (/D\d+/.test(n) && /L\d+/.test(n) && !isPipe);
    const materialRemovalRatio = clamp((pocketCount*0.1 + stepFaceCount*0.04 + (sheetScore < 0.45 ? 0.25 : 0.05)), 0.03, 0.82);

    return { dims, thickness, volumeCm3, surfaceCm2, holeCount, tapCandidates, sheetScore, bendCandidates, pocketCount, stepFaceCount, rotational, materialRemovalRatio, isPipe, isProfile, isLathe, textSize };
  },
  dimensionsFromName(n, idx){
    const l = n.match(/(?:L|길이)(\d{2,5})/i)?.[1];
    const d = n.match(/(?:D|Ø)(\d{1,4})/i)?.[1];
    const wh = n.match(/(\d{2,4})[Xx\*](\d{2,4})(?:[Xx\*](\d{1,4}))?/);
    if(wh) return { x:+wh[1], y:+wh[2], z: wh[3] ? +wh[3] : (d ? +d : 10) };
    if(l && d) return { x:+l, y:+d, z:+d };
    if(l) return { x:+l, y:40+(idx%5)*15, z:20+(idx%4)*8 };
    return { x:80+(idx%7)*35, y:50+(idx%5)*22, z:8+(idx%6)*6 };
  },
  thicknessFromName(n, dims){
    const t = n.match(/(\d+(?:\.\d+)?)T\b/)?.[1];
    if(t) return +t;
    const z = Math.min(dims.x,dims.y,dims.z);
    if(NameRules.sheetHint(n)) return clamp(z, 0.8, 6);
    return z;
  },
  holesFromName(n, idx, dims){
    const m = n.match(/(?:HOLE|홀|TAP|탭)[_\-]?(\d{1,3})/)?.[1];
    if(m) return +m;
    if(NameRules.isPurchase(n)) return 0;
    if(NameRules.cncHint(n)) return 2 + (idx % 8);
    if(NameRules.sheetHint(n)) return idx % 6;
    return idx % 3;
  },
  tapCandidates(n, holes, thickness){
    if(!holes) return [];
    const sizes = ['M3','M4','M5','M6','M8','M10','M12'];
    const prefer = n.match(/M(3|4|5|6|8|10|12)/)?.[0] || (thickness >= 8 ? 'M8' : thickness >= 4 ? 'M6' : 'M4');
    const count = Math.min(holes, /TAP|탭/.test(n) ? holes : Math.ceil(holes*0.45));
    return [{ size: prefer, count, kind: thickness > 8 ? 'blind' : 'through', checked: count>0 }];
  },
  sheetScore(n, dims, thickness, sheetHint, isPipe, isProfile){
    if(isPipe || isProfile) return 0;
    const minDim = Math.min(dims.x,dims.y,dims.z);
    const maxDim = Math.max(dims.x,dims.y,dims.z);
    const thinRatio = minDim / Math.max(1,maxDim);
    let s = 0;
    if(thickness <= 6) s += 0.35;
    if(thinRatio < 0.12) s += 0.35;
    if(sheetHint) s += 0.25;
    if(/BLOCK|BASE|JIG|SHAFT/.test(n)) s -= 0.35;
    return clamp(s,0,1);
  }
};

const BendAnalyzer = {
  estimate({ name, dims, thickness, sheetScore, bendHint, isPipe, isProfile }){
    if(isPipe || isProfile) return [];
    const hasConstantThickness = thickness > 0 && thickness <= 6;
    const isSheetLike = sheetScore >= 0.58;
    // 핵심: 같은 두께 판재 + 휨/R/플랜지/절곡 힌트가 있을 때만 절곡 후보 자동 생성.
    // 단순 얇은 판은 판금 후보일 수 있지만 절곡 횟수는 0으로 둔다.
    if(!hasConstantThickness || !isSheetLike || !bendHint) return [];
    const u = /U_BRACKET|U-BRACKET|ㄷ|BOX|CASE/.test(name);
    const z = /Z_BRACKET|Z-BRACKET/.test(name);
    const l = /L_BRACKET|L-BRACKET|ANGLE/.test(name);
    const flange = /FLANGE|플랜지/.test(name);
    let count = l ? 1 : u ? 2 : z ? 2 : flange ? 2 : 1;
    if(/COVER|BOX|CASE|커버/.test(name)) count = Math.max(count, 4);
    const lengthBase = Math.max(30, Math.min(dims.x,dims.y));
    return Array.from({length: count}, (_,i)=>({
      id: 'B'+(i+1), checked: true, angle: i%2===0?90:135, length: Math.round(lengthBase * (1 + (i%3)*0.18)), thickness, radiusDetected: true,
      reason: '같은 두께 유지 + 절곡/플랜지 힌트'
    }));
  }
};

const ProcessClassifier = {
  classify(part){
    const n = safeUpper(part.name);
    const f = part.feature;
    const scores = {};
    const reasons = [];

    if(NameRules.isPurchase(n)) return result('구매품', 98, ['표준 구매품/파이프/각관/튜브 우선']);
    if(NameRules.isProfile(n)) return result('프로파일/압출', 94, ['프로파일 규격/이름 감지', 'PIPE/TUBE는 구매품으로 제외됨']);
    if(NameRules.isLathe(n) || f.rotational) return result('선반', 86, ['축/핀/부싱/원통 대칭 후보']);

    // Sheet metal and bend: same thickness sheet first, bend only if bendCandidates exist.
    if(f.sheetScore >= 0.58){
      if(f.bendCandidates.length) return result('판금/절곡', 88, ['얇은 판재형', '같은 두께 유지', `절곡 후보 ${f.bendCandidates.length}회`]);
      return result('판금/절곡', 62, ['얇은 판재형', '절곡 자동 후보 없음: 공장 수정 필요']);
    }

    if(NameRules.plasticHint(n) && f.volumeCm3 < 250) return result('3D프린팅', 55, ['소형 플라스틱/케이스 후보']);
    if(NameRules.plasticHint(n) && f.volumeCm3 >= 250) return result('사출', 52, ['플라스틱 양산 후보: 금형비 기본 미포함']);

    let cncScore = 0;
    if(NameRules.cncHint(n)) { cncScore += 18; reasons.push('CNC 이름 힌트'); }
    if(f.sheetScore < 0.45) { cncScore += 24; reasons.push('같은 두께 판재 아님'); }
    if(f.pocketCount > 0) { cncScore += 22; reasons.push(`포켓/홈 후보 ${f.pocketCount}`); }
    if(f.stepFaceCount > 1) { cncScore += 15; reasons.push('단차/높이 차 후보'); }
    if(f.tapCandidates.reduce((a,b)=>a+b.count,0) > 0) { cncScore += 12; reasons.push('탭 후보 있음'); }
    if(f.materialRemovalRatio > 0.22) { cncScore += 12; reasons.push('소재 제거율 후보'); }
    if(cncScore >= 35) return result('CNC/MCT', clamp(cncScore,35,92), reasons);

    return result('분류 필요', 30, ['자동 확정 어려움: 공장 선택 필요']);

    function result(process, confidence, rs){ return { process, confidence, reasons: rs }; }
  }
};

const QuotePart = {
  fromParsed(p, feature, cls){
    const defaultMaterial = cls.process === '구매품' ? 'SS400' : cls.process === '3D프린팅' ? 'ABS' : cls.process === '사출' ? 'PP' : cls.process === '판금/절곡' ? 'SUS304' : 'AL6061';
    return {
      id: uniqueId(), sourceId:p.id, name:p.name, qty:1, checked:false,
      process:cls.process, material:defaultMaterial, margin: DEFAULT_RATES.processMargins[cls.process] ?? 20,
      feature, classification:cls, taps: structuredClone(feature.tapCandidates), bends: structuredClone(feature.bendCandidates),
      purchaseUnit: 0, quote: null
    };
  }
};

function mergeSameLeafParts(parts){
  const map = new Map();
  for(const p of parts){
    const key = safeUpper(p.name).replace(/COPY\d+|INSTANCE\d+/g,'');
    if(map.has(key)) map.get(key).qty += p.qty;
    else map.set(key, p);
  }
  return [...map.values()];
}

function recalcAll(){ AppState.parts.forEach(p => p.quote = QuoteEngine.calculate(p, AppState.rates)); }

const QuoteEngine = {
  materialUnit(material){
    const m = AppState.rates.materials[material] || AppState.rates.materials.AL6061;
    if(m.mode === 'fixed') return m.market + m.add;
    if(m.mode === 'percent') return m.market * (1 + m.add/100);
    if(m.mode === 'direct') return m.add;
    return m.market;
  },
  weightKg(part){
    const mat = AppState.rates.materials[part.material] || AppState.rates.materials.AL6061;
    return part.feature.volumeCm3 * mat.density / 1000;
  },
  materialCost(part){ return this.weightKg(part) * this.materialUnit(part.material) * part.qty; },
  calculate(part, rates){
    const material = this.materialCost(part);
    let processCost = 0, extras = 0, base = 0;
    const f = part.feature;
    switch(part.process){
      case '구매품': {
        const n=safeUpper(part.name); let unit = part.purchaseUnit || rates.purchase.defaultUnit;
        const lenM = (f.dims.x || 100) / 1000;
        if(/PIPE|TUBE|각관|파이프|튜브/.test(n)) unit = lenM * (/SUS|STS/.test(n) ? rates.purchase.pipePerM*1.35 : rates.purchase.pipePerM);
        if(/SQUARE_TUBE/.test(n)) unit = lenM * rates.purchase.squareTubePerM;
        if(/BEARING/.test(n)) unit = rates.purchase.bearingDefault;
        if(/MOTOR/.test(n)) unit = rates.purchase.motorDefault;
        if(/SENSOR/.test(n)) unit = rates.purchase.sensorDefault;
        processCost = unit * part.qty; break;
      }
      case '프로파일/압출': {
        const n=safeUpper(part.name); const lenM=(f.dims.x||100)/1000;
        let mRate = rates.profile.m4040;
        if(/2020/.test(n)) mRate = rates.profile.m2020; if(/3030/.test(n)) mRate = rates.profile.m3030; if(/4080/.test(n)) mRate = rates.profile.m4080;
        processCost = (lenM*mRate + rates.profile.cut + (part.taps?.[0]?.count||0)*rates.profile.tab) * part.qty; break;
      }
      case '선반': {
        const size = Math.max(f.dims.x,f.dims.y,f.dims.z); base = size<80?rates.lathe.small:size<250?rates.lathe.medium:rates.lathe.large;
        extras = (f.pocketCount||0)*rates.lathe.groove + (part.taps?.reduce((a,t)=>a+t.count,0)||0)*rates.lathe.thread;
        processCost = (base + extras) * part.qty; break;
      }
      case '판금/절곡': {
        const cut = (2*(f.dims.x+f.dims.y)/1000) * rates.sheet.cutPerM;
        const holes = f.holeCount * rates.sheet.hole;
        const bendCost = (part.bends||[]).filter(b=>b.checked).reduce((sum,b)=>sum + bendPrice(b, part.material, rates), 0);
        const tab = tabCost(part, rates, 'sheet');
        processCost = (rates.sheet.base + cut + holes + bendCost + tab + (bendCost>0?rates.sheet.bendSetup:0)) * part.qty; break;
      }
      case 'CNC/MCT': {
        const max = Math.max(f.dims.x,f.dims.y,f.dims.z); base=max<90?rates.cnc.small:max<250?rates.cnc.medium:rates.cnc.large;
        extras = f.pocketCount*rates.cnc.pocket + f.stepFaceCount*rates.cnc.step + f.holeCount*rates.cnc.hole + tabCost(part, rates, 'cnc');
        processCost = (base + rates.cnc.setup + extras) * part.qty; break;
      }
      case '3D프린팅': {
        processCost = (f.volumeCm3 * rates.printing.fdmCm3 * (f.bendCandidates.length?rates.printing.supportFactor:1) + rates.printing.finish) * part.qty; break;
      }
      case '사출': {
        const mold = rates.injection.moldDefaultIncluded ? (f.volumeCm3<80?rates.injection.moldSimple:f.volumeCm3<300?rates.injection.moldNormal:rates.injection.moldComplex) : 0;
        processCost = mold + rates.injection.unit * part.qty; break;
      }
      case '용접': {
        const weldLen = (f.dims.x+f.dims.y)/100; processCost = (rates.weld.base + weldLen*rates.weld.per100mm + rates.weld.finish) * part.qty; break;
      }
      case '제외': processCost = 0; break;
      default: processCost = material; break;
    }
    const beforeMargin = (part.process === '구매품') ? processCost : (material + processCost);
    const margin = beforeMargin * ((+part.margin||0)/100);
    const total = beforeMargin + margin;
    return { material, processCost, beforeMargin, margin, total };
  }
};

function bendPrice(b, material, rates){
  const table = rates.sheet.bendByThickness;
  const base = (table.find(x => b.thickness <= x.max) || table[table.length-1]).price;
  const lenF = (rates.sheet.longFactors.find(x => b.length <= x.max) || rates.sheet.longFactors.at(-1)).factor;
  let matF = 1;
  if(material === 'SUS304') matF = rates.sheet.susFactor;
  if(material === 'AL6061') matF = rates.sheet.alFactor;
  return base * lenF * matF;
}

function tabCost(part, rates, mode){
  const taps = part.taps || [];
  return taps.filter(t=>t.checked !== false).reduce((sum,t)=>{
    const base = rates.cnc.tabBase[t.size] || rates.cnc.tabBase.M6;
    let factor = 1;
    if(t.kind === 'blind') factor *= rates.cnc.blindFactor;
    if(t.kind === 'deep') factor *= rates.cnc.deepFactor;
    if(part.material === 'SUS304') factor *= rates.cnc.susFactor;
    return sum + base * factor * t.count;
  },0);
}

function renderParts(){
  const body = document.getElementById('partsBody');
  if(!AppState.parts.length){ body.innerHTML = '<tr><td colspan="10" class="empty">STEP 파일을 업로드하세요.</td></tr>'; return; }
  body.innerHTML = AppState.parts.map(p => rowHtml(p)).join('');
  body.querySelectorAll('tr[data-id]').forEach(tr => tr.addEventListener('click', e => {
    if(['SELECT','INPUT','BUTTON'].includes(e.target.tagName)) return;
    selectPart(tr.dataset.id);
  }));
  body.querySelectorAll('[data-edit]').forEach(el => el.addEventListener('change', onCellEdit));
}
function rowHtml(p){
  const q = p.quote || {total:0};
  const reason = p.classification.reasons.slice(0,3).map(r=>`<span class="pill">${escapeHtml(r)}</span>`).join(' ');
  return `<tr data-id="${p.id}" class="${AppState.selectedId===p.id?'active':''}">
    <td><input type="checkbox" data-edit="checked" data-id="${p.id}" ${p.checked?'checked':''}></td>
    <td><b>${escapeHtml(p.name)}</b><br><span class="muted">${p.sourceId}</span></td>
    <td><input class="small-input" type="number" min="0" data-edit="qty" data-id="${p.id}" value="${p.qty}"></td>
    <td class="reason">추천: <b>${p.classification.process}</b> / 신뢰 ${p.classification.confidence}%<br>${reason}</td>
    <td>${selectHtml('process', p.id, PROCESS_LIST, p.process)}</td>
    <td>${selectHtml('material', p.id, MATERIAL_LIST, p.material)}</td>
    <td>${tapEditorHtml(p)}</td>
    <td>${bendEditorHtml(p)}</td>
    <td><input class="small-input" type="number" data-edit="margin" data-id="${p.id}" value="${p.margin}"></td>
    <td><b>${money(q.total)}</b></td>
  </tr>`;
}
function selectHtml(field,id,items,value){ return `<select data-edit="${field}" data-id="${id}">`+items.map(x=>`<option ${x===value?'selected':''}>${x}</option>`).join('')+'</select>'; }
function tapEditorHtml(p){
  const count = (p.taps||[]).reduce((a,t)=>a+(t.checked!==false?t.count:0),0);
  return `<input class="small-input" type="number" data-edit="tapCount" data-id="${p.id}" value="${count}"><span class="muted">개</span>`;
}
function bendEditorHtml(p){
  const count = (p.bends||[]).filter(b=>b.checked).length;
  return `<input class="small-input" type="number" data-edit="bendCount" data-id="${p.id}" value="${count}"><span class="muted">회</span>`;
}
function onCellEdit(e){
  const p = AppState.parts.find(x=>x.id===e.target.dataset.id); if(!p) return;
  const f = e.target.dataset.edit;
  if(f==='checked') p.checked = e.target.checked;
  if(f==='qty') p.qty = Math.max(0, +e.target.value || 0);
  if(f==='process') { p.process = e.target.value; p.margin = AppState.rates.processMargins[p.process] ?? p.margin; }
  if(f==='material') p.material = e.target.value;
  if(f==='margin') p.margin = +e.target.value || 0;
  if(f==='tapCount') p.taps = [{ size: p.material==='SUS304'?'M6':'M4', count: Math.max(0,+e.target.value||0), kind: 'through', checked:true }];
  if(f==='bendCount') {
    const n = Math.max(0,+e.target.value||0); p.bends = Array.from({length:n},(_,i)=>({id:'M'+i, checked:true, angle:90, length:Math.min(p.feature.dims.x,p.feature.dims.y), thickness:p.feature.thickness, radiusDetected:true, reason:'수동 입력'}));
  }
  p.quote = QuoteEngine.calculate(p, AppState.rates);
  renderParts(); renderSummary(); if(AppState.selectedId===p.id) renderDetail(p);
}
function selectedParts(){ return AppState.parts.filter(p=>p.checked); }
function selectPart(id){ AppState.selectedId = id; const p=AppState.parts.find(x=>x.id===id); renderParts(); renderDetail(p); }
function renderDetail(p){
  if(!p) return;
  document.getElementById('viewer').innerHTML = partSvg(p);
  const f=p.feature, q=p.quote;
  document.getElementById('partDetail').innerHTML = `<b>${escapeHtml(p.name)}</b><br>
    공법: ${p.process} / 재질: ${p.material} / 수량: ${p.qty}<br>
    크기 추정: ${f.dims.x} × ${f.dims.y} × ${f.dims.z} mm / 두께: ${f.thickness}T<br>
    판재 점수: ${(f.sheetScore*100).toFixed(0)} / 절곡 후보: ${p.bends.length} / 탭 후보: ${(p.taps||[]).reduce((a,t)=>a+t.count,0)}<br>
    <hr>재료비 ${money(q.material)} / 공정비 ${money(q.processCost)} / 마진 ${money(q.margin)}<br><b>파트 견적: ${money(q.total)}</b>`;
}
function partSvg(p){
  const proc = p.process;
  const color = proc==='판금/절곡'?'#2563eb':proc==='CNC/MCT'?'#475569':proc==='구매품'?'#0f766e':proc==='프로파일/압출'?'#9333ea':'#b45309';
  const bends = p.bends.length;
  let shape = `<rect x="80" y="65" width="190" height="110" rx="10" fill="${color}" opacity=".82"/>`;
  if(proc==='판금/절곡') shape = `<path d="M55 160 L135 160 ${bends? 'Q150 160 150 145 L150 80 Q150 65 165 65 L285 65':'L285 160'}" fill="none" stroke="${color}" stroke-width="24" stroke-linejoin="round" stroke-linecap="round"/>`;
  if(proc==='구매품' && /PIPE|TUBE|파이프|튜브|각관/.test(safeUpper(p.name))) shape = `<rect x="55" y="100" width="260" height="55" rx="27" fill="${color}" opacity=".85"/><rect x="85" y="113" width="200" height="29" rx="15" fill="#ecfeff" opacity=".8"/>`;
  if(proc==='프로파일/압출') shape = `<rect x="55" y="80" width="260" height="95" fill="${color}" opacity=".75"/><line x1="55" y1="128" x2="315" y2="128" stroke="white" stroke-width="8" opacity=".8"/><line x1="185" y1="80" x2="185" y2="175" stroke="white" stroke-width="8" opacity=".8"/>`;
  return `<svg viewBox="0 0 370 240" xmlns="http://www.w3.org/2000/svg"><rect width="370" height="240" fill="#f8fafc"/>${shape}<text x="24" y="30" font-size="16" font-weight="700" fill="#111827">${escapeHtml(p.name).slice(0,32)}</text><text x="24" y="215" font-size="13" fill="#475569">${proc} · ${p.material} · ${money(p.quote.total)}</text></svg>`;
}
function renderSummary(parsed){
  const total = AppState.parts.reduce((s,p)=>s+(p.quote?.total||0),0);
  const material = AppState.parts.reduce((s,p)=>s+(p.quote?.material||0),0);
  const process = AppState.parts.reduce((s,p)=>s+(p.quote?.processCost||0),0);
  const margin = AppState.parts.reduce((s,p)=>s+(p.quote?.margin||0),0);
  document.getElementById('partCount').textContent = AppState.parts.length;
  document.getElementById('asmCount').textContent = parsed?.asmLike || '-';
  document.getElementById('totalQuote').textContent = money(total);
  document.getElementById('quoteBreakdown').innerHTML = `<div class="box"><b>${money(total)}</b><span>고객 제출가</span></div><div class="box"><b>${money(material)}</b><span>재료비</span></div><div class="box"><b>${money(process)}</b><span>공정/구매비</span></div><div class="box"><b>${money(margin)}</b><span>공법별 마진</span></div>`;
}
function renderRateEditor(){
  const r=AppState.rates;
  document.getElementById('rateEditor').innerHTML = `<div class="rate-card"><h3>공법별 마진</h3>${Object.entries(r.processMargins).map(([k,v])=>`<div class="rate-row"><span>${k}</span><input type="number" data-rate-margin="${k}" value="${v}"></div>`).join('')}</div>
  <div class="rate-card"><h3>재료 시세 + 할증</h3>${Object.entries(r.materials).slice(0,6).map(([k,v])=>`<div class="rate-row"><span>${k}</span><input type="number" data-material-add="${k}" value="${v.add}"></div>`).join('')}</div>
  <div class="rate-card"><h3>절곡 기준</h3><div class="rate-row"><span>절곡 셋업비</span><input type="number" data-rate-path="sheet.bendSetup" value="${r.sheet.bendSetup}"></div><div class="rate-row"><span>SUS 절곡 할증</span><input type="number" step="0.01" data-rate-path="sheet.susFactor" value="${r.sheet.susFactor}"></div></div>`;
  document.querySelectorAll('[data-rate-margin]').forEach(i=>i.addEventListener('change',()=>{ r.processMargins[i.dataset.rateMargin]=+i.value||0; AppState.parts.forEach(p=>{ if(p.process===i.dataset.rateMargin) p.margin=+i.value||0; }); recalcAll(); renderParts(); renderSummary(); }));
  document.querySelectorAll('[data-material-add]').forEach(i=>i.addEventListener('change',()=>{ r.materials[i.dataset.materialAdd].add=+i.value||0; recalcAll(); renderParts(); renderSummary(); }));
  document.querySelectorAll('[data-rate-path]').forEach(i=>i.addEventListener('change',()=>{ setPath(r,i.dataset.ratePath,+i.value||0); recalcAll(); renderParts(); renderSummary(); }));
}
function setPath(obj,path,val){ const ps=path.split('.'); let o=obj; while(ps.length>1){ o=o[ps.shift()]; } o[ps[0]]=val; }
function exportCsv(){
  const rows = [['파트명','수량','공법','재질','탭','절곡','마진','견적가']].concat(AppState.parts.map(p=>[p.name,p.qty,p.process,p.material,(p.taps||[]).reduce((a,t)=>a+t.count,0),p.bends.length,p.margin,Math.round(p.quote.total)]));
  const csv = rows.map(r=>r.map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob = new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='step_quote.csv'; a.click();
}
function escapeHtml(s){ return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
