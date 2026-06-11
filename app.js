'use strict';

const PROCESS = ['CNC/MCT','선반','판금/절곡','3D프린팅','사출','프로파일/압출','용접','구매품','제외','분류 필요'];
const MATERIALS = ['AL6061','SUS304','SS400','ABS','POM','PLA','PP','PC','기타'];
let parts = [];
let selectedId = null;

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n || 0).toLocaleString('ko-KR') + '원';
const norm = (s) => String(s || '').replace(/\\X2\\.*?\\X0\\/g,'').replace(/''/g,"'").replace(/["']/g,'').trim();

function setMsg(text, type='') {
  const el = $('message'); el.textContent = text; el.className = 'message ' + type;
}

function splitTopArgs(s) {
  const out=[]; let cur='', depth=0, quote=false;
  for (let i=0;i<s.length;i++) {
    const c=s[i], n=s[i+1];
    if (c==="'" && n==="'") { cur+=c+n; i++; continue; }
    if (c==="'") quote=!quote;
    if (!quote) { if (c==='(') depth++; else if (c===')') depth--; }
    if (c===',' && depth===0 && !quote) { out.push(cur.trim()); cur=''; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseStepEntities(text) {
  const entities = new Map();
  const clean = text.replace(/\/\*[\s\S]*?\*\//g,' ');
  const re = /#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*?)\)\s*;/g;
  let m;
  while ((m = re.exec(clean))) {
    const id = '#' + m[1];
    const type = m[2];
    const argsRaw = m[3];
    entities.set(id, { id, type, argsRaw, args: splitTopArgs(argsRaw), raw: m[0] });
  }
  return entities;
}

function firstString(args, fallback='') {
  for (const a of args || []) {
    const m = a.match(/^\s*'([\s\S]*?)'\s*$/);
    if (m && norm(m[1]) && norm(m[1]) !== '$') return norm(m[1]);
  }
  return fallback;
}

function refList(s) {
  return Array.from(String(s||'').matchAll(/#\d+/g)).map(m=>m[0]);
}

function parseStepText(text, fileName) {
  const entities = parseStepEntities(text);
  const products = new Map();
  const formations = new Map();
  const pdefs = new Map();
  const allProducts = [];

  for (const e of entities.values()) {
    if (e.type === 'PRODUCT') {
      const name = firstString(e.args, 'PRODUCT_' + e.id.slice(1));
      products.set(e.id, { id:e.id, name });
      allProducts.push({ id:e.id, name });
    }
  }
  for (const e of entities.values()) {
    if (e.type === 'PRODUCT_DEFINITION_FORMATION' || e.type === 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE') {
      const refs = refList(e.argsRaw);
      const prod = refs.find(r => products.has(r));
      if (prod) formations.set(e.id, { id:e.id, productId:prod, name:products.get(prod).name });
    }
  }
  for (const e of entities.values()) {
    if (e.type === 'PRODUCT_DEFINITION') {
      const refs = refList(e.argsRaw);
      const form = refs.find(r => formations.has(r));
      const ownName = firstString(e.args, '');
      if (form) pdefs.set(e.id, { id:e.id, formationId:form, name: ownName || formations.get(form).name });
    }
  }

  const edges = [];
  for (const e of entities.values()) {
    if (e.type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') {
      const refs = refList(e.argsRaw).filter(r => pdefs.has(r));
      if (refs.length >= 2) {
        const parent = refs[0], child = refs[1];
        const occName = firstString(e.args, '');
        edges.push({ id:e.id, parent, child, name: occName || pdefs.get(child).name });
      }
    }
  }

  const parentSet = new Set(edges.map(e=>e.parent));
  const childSet = new Set(edges.map(e=>e.child));
  const leafPdefs = [...childSet].filter(id => !parentSet.has(id));
  const excludedAsm = parentSet.size;

  let rawParts = [];
  if (leafPdefs.length) {
    for (const pd of leafPdefs) {
      const occurrences = edges.filter(e => e.child === pd);
      const name = pdefs.get(pd)?.name || occurrences[0]?.name || 'PART_' + pd.slice(1);
      rawParts.push({ sourceId: pd, name, quantity: Math.max(1, occurrences.length), source:'assembly-leaf' });
    }
  } else if (allProducts.length) {
    // 단품 STEP이거나 어셈블리 링크가 없는 파일. PRODUCT를 파트 후보로 사용한다.
    rawParts = allProducts.map(p => ({ sourceId:p.id, name:p.name, quantity:1, source:'product-fallback' }));
  }

  if (!rawParts.length) {
    const breps = [];
    for (const e of entities.values()) {
      if (/BREP|SHAPE_REPRESENTATION|SOLID_MODEL|CLOSED_SHELL/.test(e.type)) {
        const name = firstString(e.args, e.type + '_' + e.id.slice(1));
        if (name && !/^\$|\*/.test(name)) breps.push({ sourceId:e.id, name, quantity:1, source:'brep-fallback' });
      }
    }
    rawParts = breps.slice(0, 500);
  }

  // 동일 파트명 집계. 어셈블리/서브어셈블리명은 leaf가 아닌 경우 제외됐음.
  const grouped = new Map();
  for (const p of rawParts) {
    const key = normalizePartName(p.name || 'UNNAMED_PART');
    if (!grouped.has(key)) grouped.set(key, { name:key, quantity:0, sourceIds:[], source:p.source });
    grouped.get(key).quantity += p.quantity;
    grouped.get(key).sourceIds.push(p.sourceId);
  }

  return {
    fileName,
    entityCount: entities.size,
    productCount: products.size,
    edgeCount: edges.length,
    excludedAsm,
    parts: [...grouped.values()].filter(p => !isAssemblyName(p.name)).slice(0, 1000)
  };
}

function normalizePartName(name) {
  let n = norm(name) || 'UNNAMED_PART';
  n = n.replace(/\.(SLDPRT|PRT|STEP|STP)$/i,'');
  n = n.replace(/\s+/g,'_');
  return n;
}
function isAssemblyName(name) { return /ASSEMBLY|ASSY|ASM|SUB[_-]?ASM|조립|어셈/i.test(name) && !/PART|PLATE|BRACKET|PIPE|TUBE|SHAFT|COVER/i.test(name); }

function estimateFeatures(name, qty) {
  const N = name.toUpperCase();
  const dims = extractDims(N);
  const thickness = extractThickness(N, dims);
  const longLen = Math.max(dims.l, dims.w, dims.h);
  const shortLen = Math.min(dims.l, dims.w, dims.h);
  const sheetLikeName = /SHEET|PANEL|COVER|BRACKET|PLATE|판금|커버|판넬/i.test(N);
  const bendHint = /BEND|BENT|FOLD|FLANGE|L[_-]?BRACKET|U[_-]?BRACKET|절곡|접힘|ㄱ|ㄷ/i.test(N);
  const pipeName = /PIPE|TUBE|SQUARE[_-]?TUBE|RECT[_-]?TUBE|ROUND[_-]?TUBE|파이프|각관|배관|튜브/i.test(N);
  const profileName = /PROFILE|AL[_-]?FRAME|ALFRAME|프로파일|압출|\b(2020|3030|4040|4080|4545|5050|6060|8080)\b/i.test(N);
  const rotational = /SHAFT|PIN|BUSH|BUSHING|ROLLER|SPACER|COLLAR|축|핀|부시|롤러/i.test(N) || /^D\d+[_-]?L\d+/.test(N);
  const purchaseName = /BOLT|NUT|WASHER|BEARING|SENSOR|MOTOR|CYLINDER|SCREW|BALL[_-]?SCREW|LM|GUIDE[_-]?RAIL|VALVE|FAN|HINGE|HANDLE|KNOB|볼트|너트|베어링|센서|모터|실린더|구매/i.test(N) || pipeName;
  const thinSheet = (thickness > 0 && thickness <= 6 && (dims.l / Math.max(1, thickness) > 10 || dims.w / Math.max(1, thickness) > 10)) || (sheetLikeName && thickness <= 6);
  const isBent = thinSheet && bendHint;
  const tap = estimateTapCount(N, dims, purchaseName);
  const bends = isBent ? estimateBendCount(N) : 0;
  const pocket = /POCKET|SLOT|GROOVE|홈|포켓|SINK|BORE/i.test(N) ? 1 : 0;
  return { dims, thickness, longLen, shortLen, purchaseName, pipeName, profileName, rotational, thinSheet, bendHint, isBent, tap, bends, pocket };
}

function extractDims(N) {
  let l=80,w=50,h=8;
  const mm3 = N.match(/(\d+(?:\.\d+)?)\s*[X×]\s*(\d+(?:\.\d+)?)\s*[X×]\s*(\d+(?:\.\d+)?)/i);
  if (mm3) { l=+mm3[1]; w=+mm3[2]; h=+mm3[3]; }
  const L = N.match(/(?:^|[_-])L\s*(\d+(?:\.\d+)?)/i); if (L) l=+L[1];
  const W = N.match(/(?:^|[_-])W\s*(\d+(?:\.\d+)?)/i); if (W) w=+W[1];
  const H = N.match(/(?:^|[_-])H\s*(\d+(?:\.\d+)?)/i); if (H) h=+H[1];
  const D = N.match(/(?:^|[_-])D\s*(\d+(?:\.\d+)?)/i); if (D) { w=+D[1]; h=+D[1]; }
  return {l,w,h};
}
function extractThickness(N, dims) {
  const t = N.match(/(?:^|[_-]|\s)(?:T|THK)(\d+(?:\.\d+)?)/i) || N.match(/(\d+(?:\.\d+)?)T/i);
  if (t) return +t[1];
  return Math.min(dims.l,dims.w,dims.h);
}
function estimateTapCount(N, dims, purchase) {
  if (purchase) return 0;
  const explicit = N.match(/(?:TAP|M\d+)[_-]?(?:X)?(\d+)/i); if (explicit) return +explicit[1];
  if (/TAP|M3|M4|M5|M6|M8|M10|M12|탭/i.test(N)) return 4;
  if (/BASE|PLATE|JIG|FIXTURE/i.test(N)) return 4;
  return 0;
}
function estimateBendCount(N) {
  const explicit = N.match(/(?:BEND|절곡)[_-]?(\d+)/i); if (explicit) return +explicit[1];
  if (/U[_-]?BRACKET|ㄷ/i.test(N)) return 2;
  if (/L[_-]?BRACKET|ㄱ/i.test(N)) return 1;
  if (/BOX|CASE|COVER/i.test(N)) return 4;
  if (/FLANGE/i.test(N)) return 2;
  return 1;
}

function classifyPart(name, features) {
  const N = name.toUpperCase();
  const why=[];
  if (features.purchaseName) {
    why.push(features.pipeName ? '파이프/튜브/각관은 구매재 우선' : '표준 구매품 이름 감지');
    return { process:'구매품', confidence:'높음', why };
  }
  if (features.profileName && !features.pipeName) {
    why.push('프로파일/압출 규격 또는 이름 감지');
    return { process:'프로파일/압출', confidence:'높음', why };
  }
  if (features.rotational) {
    why.push('축/핀/부시/롤러 계열 회전체 이름 감지');
    return { process:'선반', confidence:'높음', why };
  }
  if (features.isBent) {
    why.push('얇은 판재형 + BEND/FLANGE/L/U 브라켓 힌트');
    return { process:'판금/절곡', confidence:'높음', why };
  }
  if (features.thinSheet && /SHEET|PANEL|COVER|BRACKET|PLATE|판금|커버|판넬/i.test(N)) {
    why.push('얇은 판재형이지만 절곡 힌트 없음: 절곡 0회로 시작');
    return { process:'판금/절곡', confidence:'보통', why };
  }
  if (/CASE|HOUSING|COVER|PLASTIC|ABS|PP|PC|사출/i.test(N) && !/METAL|AL|SUS|SS/i.test(N)) {
    why.push('케이스/플라스틱 양산 후보');
    return { process:'사출', confidence:'낮음', why };
  }
  if (/PRINT|3DP|PROTO|시제품/i.test(N)) {
    why.push('3D프린팅/시제품 이름 힌트');
    return { process:'3D프린팅', confidence:'보통', why };
  }
  const cncHints = [];
  if (/BASE|BLOCK|JIG|FIXTURE|MOUNT|HOLDER|SUPPORT|ADAPTER|CLAMP|GUIDE|PLATE/i.test(N)) cncHints.push('절삭 가공품 이름 힌트');
  if (features.tap > 0) cncHints.push('탭/홀 후보');
  if (features.pocket > 0) cncHints.push('포켓/홈 후보');
  if (cncHints.length) return { process:'CNC/MCT', confidence:'보통', why:cncHints };
  return { process:'분류 필요', confidence:'낮음', why:['명확한 공법 힌트 없음'] };
}

function materialPrice(material) {
  if (material === 'AL6061') return +$('matAL').value || 7200;
  if (material === 'SUS304') return +$('matSUS').value || 6800;
  if (material === 'SS400') return +$('matSS').value || 2400;
  if (['ABS','POM','PLA','PP','PC'].includes(material)) return +$('matABS').value || 4800;
  return 5000;
}
function marginFor(process) { return +(document.querySelector(`[data-margin="${CSS.escape(process)}"]`)?.value || 20); }

function estimateWeightKg(p) {
  const {l,w,h} = p.features.dims;
  const volumeCm3 = Math.max(1, l*w*h / 1000);
  let density = 2.7;
  if (p.material === 'SUS304' || p.material === 'SS400') density = 7.85;
  if (['ABS','POM','PLA','PP','PC'].includes(p.material)) density = 1.15;
  const fill = p.process === '판금/절곡' ? 0.18 : p.process === '프로파일/압출' ? 0.22 : p.process === '구매품' ? 0.12 : 0.55;
  return volumeCm3 * density / 1000 * fill;
}

function calcPart(p) {
  if (p.process === '제외') return {material:0, processCost:0, margin:0, total:0, details:'제외'};
  const q = Math.max(1, +p.qty || 1);
  const weight = estimateWeightKg(p) * q;
  const material = Math.max(500, weight * materialPrice(p.material));
  const d = p.features.dims;
  const sizeRank = Math.max(d.l,d.w,d.h) < 120 ? 1 : Math.max(d.l,d.w,d.h) < 500 ? 2 : 3;
  let processCost = 0, details=[];
  switch (p.process) {
    case '구매품':
      processCost = Math.max(1000*q, material * 1.15); details.push('구매품 단가 추정'); break;
    case '프로파일/압출':
      processCost = Math.max(6000, (p.features.longLen/1000) * 13000 * q + 1200*q); details.push('길이×m당 단가 + 절단비'); break;
    case '선반':
      processCost = (sizeRank===1?22000:sizeRank===2?55000:120000)*q + p.taps*1200*q; details.push('선반 기본가 + 탭/홀'); break;
    case '판금/절곡':
      processCost = (25000 + p.bends*3500 + p.taps*1000) * q; details.push('판금 기본가 + 절곡/탭'); break;
    case '3D프린팅':
      processCost = Math.max(15000, (d.l*d.w*d.h/1000)*90*q); details.push('부피 기준 출력비'); break;
    case '사출':
      processCost = (p.includeMold ? 2500000 : 0) + Math.max(30000, 250*q + material); details.push(p.includeMold?'금형 포함':'금형 미포함'); break;
    case '용접':
      processCost = (50000 + sizeRank*30000)*q; details.push('용접 기본 공임'); break;
    case 'CNC/MCT':
    default:
      processCost = (sizeRank===1?65000:sizeRank===2?160000:360000)*q + p.taps*1800*q + p.features.pocket*25000*q; details.push('CNC 크기별 기본가 + 탭/포켓'); break;
  }
  const base = material + processCost;
  const margin = base * ((+p.margin || 0)/100);
  return { material, processCost, margin, total: base + margin, details: details.join(', ') };
}

function partFromRaw(raw, idx) {
  const features = estimateFeatures(raw.name, raw.quantity);
  const cls = classifyPart(raw.name, features);
  const material = cls.process === '구매품' ? '기타' : cls.process === '판금/절곡' ? (raw.name.toUpperCase().includes('SUS')||raw.name.toUpperCase().includes('STS')?'SUS304':'SS400') : (raw.name.toUpperCase().includes('SUS')||raw.name.toUpperCase().includes('STS')?'SUS304':'AL6061');
  const p = { id:'p'+idx, name:raw.name, qty:raw.quantity, autoProcess:cls.process, process:cls.process, confidence:cls.confidence, why:cls.why, features, material, thickness:features.thickness, taps:features.tap, bends:features.bends, margin:marginFor(cls.process), includeMold:false };
  p.cost = calcPart(p);
  return p;
}

function render() {
  const body = $('partsBody');
  if (!parts.length) { body.innerHTML = '<tr><td colspan="10" class="empty">분석된 말단 파트가 없습니다. 파일을 올리거나 STEP 구조를 확인하세요.</td></tr>'; }
  else {
    body.innerHTML = parts.map(p => `
      <tr data-id="${p.id}" class="${p.id===selectedId?'sel':''}">
        <td><b>${escapeHtml(p.name)}</b><div class="reason">신뢰도 ${p.confidence}</div></td>
        <td><input class="smallInput" type="number" min="0" value="${p.qty}" data-field="qty" data-id="${p.id}"></td>
        <td>${p.autoProcess}<div class="reason">${p.why.map(escapeHtml).join(' · ')}</div></td>
        <td><select data-field="process" data-id="${p.id}">${PROCESS.map(x=>`<option ${x===p.process?'selected':''}>${x}</option>`).join('')}</select></td>
        <td><select data-field="material" data-id="${p.id}">${MATERIALS.map(x=>`<option ${x===p.material?'selected':''}>${x}</option>`).join('')}</select></td>
        <td><input class="smallInput" type="number" min="0" step="0.1" value="${p.thickness}" data-field="thickness" data-id="${p.id}"></td>
        <td><input class="smallInput" type="number" min="0" value="${p.taps}" data-field="taps" data-id="${p.id}"></td>
        <td><input class="smallInput" type="number" min="0" value="${p.bends}" data-field="bends" data-id="${p.id}"></td>
        <td><input class="smallInput" type="number" min="0" value="${p.margin}" data-field="margin" data-id="${p.id}"></td>
        <td class="price">${fmt(p.cost.total)}</td>
      </tr>`).join('');
  }
  const total = parts.reduce((s,p)=>s+p.cost.total,0);
  $('statLeaf').textContent = parts.length.toLocaleString('ko-KR');
  $('statPrice').textContent = fmt(total);
  renderSelected();
}

function renderSelected() {
  const p = parts.find(x=>x.id===selectedId) || parts[0];
  const card = $('selectedCard');
  if (!p) { card.innerHTML = '<h3>선택 파트 검토</h3><p class="muted">파트 행을 클릭하세요.</p>'; return; }
  const shapeClass = p.features.pipeName ? 'pipe' : p.process==='프로파일/압출' ? 'profile' : p.process==='판금/절곡' ? 'sheet' : '';
  card.innerHTML = `<h3>선택 파트 검토</h3>
    <b>${escapeHtml(p.name)}</b>
    <div class="preview"><div class="shape ${shapeClass}"></div></div>
    <div class="badges"><span class="pill">${p.process}</span><span class="pill">${p.material}</span><span class="pill">수량 ${p.qty}</span></div>
    <div class="why">
      크기 추정: ${p.features.dims.l} × ${p.features.dims.w} × ${p.features.dims.h} mm<br>
      두께 추정: ${p.thickness}T / 탭 ${p.taps}개 / 절곡 ${p.bends}회<br>
      재료비: ${fmt(p.cost.material)}<br>
      공정비: ${fmt(p.cost.processCost)}<br>
      마진: ${fmt(p.cost.margin)}<br>
      산출: ${escapeHtml(p.cost.details)}
    </div>
    <div class="totalBox">파트 견적 ${fmt(p.cost.total)}</div>`;
}
function escapeHtml(s){return String(s).replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}

function updatePart(id, field, value) {
  const p = parts.find(x=>x.id===id); if(!p) return;
  if (['qty','thickness','taps','bends','margin'].includes(field)) p[field] = +value || 0;
  else p[field] = value;
  if (field === 'process' && (!p.margin || p.margin === marginFor(p.autoProcess))) p.margin = marginFor(p.process);
  p.cost = calcPart(p);
  render();
}

async function handleFile(file) {
  if (!file) return;
  $('statState').textContent = '분석중'; setMsg(`${file.name} 읽는 중...`);
  try {
    const buf = await file.arrayBuffer();
    let text = new TextDecoder('utf-8').decode(buf);
    if (!/ISO-10303|PRODUCT|FILE_DESCRIPTION|HEADER/i.test(text.slice(0,20000))) {
      text = new TextDecoder('latin1').decode(buf);
    }
    if (!/ISO-10303|PRODUCT|#\d+\s*=/i.test(text.slice(0,50000))) throw new Error('STEP 텍스트 구조가 감지되지 않습니다. 파일이 압축/바이너리이거나 STEP이 아닐 수 있습니다.');
    const parsed = parseStepText(text, file.name);
    $('statAsm').textContent = parsed.excludedAsm.toLocaleString('ko-KR');
    if (!parsed.parts.length) throw new Error(`말단 파트를 찾지 못했습니다. entity ${parsed.entityCount}, product ${parsed.productCount}, assembly link ${parsed.edgeCount}`);
    parts = parsed.parts.map(partFromRaw);
    selectedId = parts[0]?.id || null;
    $('statState').textContent = '완료';
    setMsg(`읽기 완료: entity ${parsed.entityCount.toLocaleString('ko-KR')}개, PRODUCT ${parsed.productCount}개, assembly link ${parsed.edgeCount}개. 어셈블리 컨테이너는 제외하고 말단 파트 ${parts.length}개만 표에 표시했습니다.`, 'ok');
    render();
  } catch (err) {
    parts=[]; selectedId=null; $('statState').textContent='실패'; $('statAsm').textContent='0'; render();
    setMsg('파일을 읽지 못했습니다: ' + err.message, 'err');
  }
}

function exportCsv(){
  const rows = [['파트명','수량','자동추천','공법','재질','두께','탭','절곡','마진%','재료비','공정비','마진','견적가']];
  for (const p of parts) rows.push([p.name,p.qty,p.autoProcess,p.process,p.material,p.thickness,p.taps,p.bends,p.margin,Math.round(p.cost.material),Math.round(p.cost.processCost),Math.round(p.cost.margin),Math.round(p.cost.total)]);
  const csv = rows.map(r=>r.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob = new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='step_quote_parts.csv'; a.click(); URL.revokeObjectURL(a.href);
}

function bind() {
  const input=$('fileInput'), dz=$('dropzone');
  input.addEventListener('change', e => handleFile(e.target.files[0]));
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); handleFile(e.dataTransfer.files[0]); });
  $('partsBody').addEventListener('click', e => { const tr=e.target.closest('tr[data-id]'); if(tr && !e.target.matches('input,select')) { selectedId=tr.dataset.id; render(); }});
  $('partsBody').addEventListener('input', e => { const id=e.target.dataset.id, field=e.target.dataset.field; if(id&&field) updatePart(id, field, e.target.value); });
  document.querySelectorAll('[data-margin],#matAL,#matSUS,#matSS,#matABS').forEach(el => el.addEventListener('input', () => { parts.forEach(p=>{p.cost=calcPart(p)}); render(); }));
  $('recalcBtn').addEventListener('click', () => { parts.forEach(p=>{p.cost=calcPart(p)}); render(); });
  $('selectAllMat').addEventListener('click', () => { parts.forEach(p=>{ if(!['구매품','제외'].includes(p.process)) p.material='AL6061'; p.cost=calcPart(p); }); render(); });
  $('exportBtn').addEventListener('click', exportCsv);
}

bind(); render();
