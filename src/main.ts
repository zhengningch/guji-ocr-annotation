import { createClient } from '@supabase/supabase-js'
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config'
import './style.css'

type Value = string | string[]
type Labels = Record<string, Value>
type BertAlert = { offset: number; char: string; error_prob: number }
type Task = {
  sample_id: number
  image_path: string
  original_filename: string
  batch: string
  note: string
  ocr_initial: string
  corrected_text: string
  status: string
  labels: Labels
  annotator_id: string | null
  annotator_name: string
  reviewer_note: string
  bert_alerts: BertAlert[] | null
  revision: number
  updated_at: string
}

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
const app = document.querySelector<HTMLDivElement>('#app')!
const selectOptions: Record<string, string[]> = {
  任务状态: ['待标注', '标注中', '待复核', '已完成', '有疑问'],
  内容部类: ['经部', '史部', '子部', '集部', '其他', '不确定'],
  页面位置: ['封面', '牌记', '序', '跋', '目录', '正文', '其他', '不确定'],
  制作方式: ['雕版刻本', '稿抄本', '活字本', '其他'],
  时代: ['唐五代', '宋', '辽金', '元', '明', '清', '民国', '其他', '不确定'],
  刻印地域: ['浙本', '蜀本', '建本', '平水本', '日本', '朝鲜', '越南', '其他', '不确定'],
  刻印单位: ['官刻本', '坊刻本', '家刻本', '其他', '不确定'],
  栏数: ['一', '二', '三', '其他'],
  界行: ['无界行', '乌丝栏', '朱丝栏', '其他', '不确定'],
  版框: ['无边栏', '四周单边', '四周双边', '左右单边', '左右双边', '其他', '不确定'],
  版心: ['有', '无', '其他', '不确定'],
  象鼻: ['白口', '黑口', '花口', '其他', '不确定'],
  书耳: ['有', '无', '其他', '不确定'],
  字体: ['楷书', '行书', '草书', '隶书', '篆书', '其他', '不确定'],
  图文版面: ['无', '图文混排', '以图为主', '图表类', '其他'],
  印章: ['无', '有但不转录', '纯印章样本', '其他', '不确定'],
  阅读顺序: ['从右到左', '从左到右', '复杂顺序', '不确定'],
}
const multiOptions: Record<string, string[]> = {
  鱼尾: ['无', '黑鱼尾', '白鱼尾', '花鱼尾', '单鱼尾', '双鱼尾', '三鱼尾', '顺鱼尾', '对鱼尾', '其他', '不确定'],
  阅读痕迹: ['无', '批注', '圈点', '训读', '墨钉', '涂改删除', '其他'],
  磨损情况: ['无明显磨损', '水渍', '油污', '虫洞', '漏字', '透字', '模糊', '遮挡', '残损', '其他'],
  数字化干扰: ['无', '水印', '光照不均', '折痕', '倾斜', '形变', '屏幕拍摄', '扫描噪声', '裁切不全', '其他'],
}

let userToken = localStorage.getItem('guji_user_token') ?? ''
let displayName = localStorage.getItem('guji_nickname') ?? ''
let tasks: Task[] = []
let filtered: Task[] = []
let currentIndex = 0
let draft: Task | null = null
let original: Task | null = null
let dirty = false
let busy = false
let zoom = 1
let rotation = 0
let panX = 0
let panY = 0
let dashboardMode = false
let undoText: string | null = null
let saveSignalTimer: number | undefined

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const basePath = import.meta.env.BASE_URL
const current = () => filtered[currentIndex]
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return (value ?? fallback) as T
  try { return JSON.parse(value) as T } catch { return fallback }
}
function normalizeTask(value: Task): Task {
  return {
    ...value,
    labels: parseJson<Labels>(value.labels, {}),
    bert_alerts: parseJson<BertAlert[]>(value.bert_alerts, []),
  }
}

async function boot() {
  userToken ? await startApp() : renderAuth()
}

function renderAuth(message = '') {
  app.innerHTML = `<main class="auth-page"><section class="auth-card">
    <div class="auth-logo">古</div><h1>古籍 OCR 标注</h1><p>输入昵称和项目密码即可进入</p>
    ${message ? `<div class="auth-message">${esc(message)}</div>` : ''}
    <form id="loginForm">
      <label>昵称<input name="name" required maxlength="30" autocomplete="username" placeholder="如：小林"></label>
      <label>项目密码<input name="password" type="password" required autocomplete="current-password"></label>
      <button class="primary" type="submit">进入标注工作台</button>
    </form><small>昵称首次使用时自动创建；再次使用同一昵称即登录原账户。</small>
  </section></main>`
  const form = document.querySelector<HTMLFormElement>('#loginForm')!
  form.addEventListener('submit', async event => {
    event.preventDefault(); setAuthBusy(true)
    const fd = new FormData(form), nickname = String(fd.get('name')).trim()
    const { data, error } = await supabase.rpc('enter_workspace', { p_nickname: nickname, p_password: String(fd.get('password')) })
    const result = Array.isArray(data) ? data[0] : data
    if (error || !result) { setAuthBusy(false); return renderAuth(error?.message?.includes('项目密码错误') ? '项目密码错误' : error?.message || '登录失败') }
    userToken = result.access_token; displayName = result.nickname
    localStorage.setItem('guji_user_token', userToken); localStorage.setItem('guji_nickname', displayName)
    await startApp()
  })
}

function setAuthBusy(value: boolean) { document.querySelectorAll<HTMLButtonElement>('.auth-card button').forEach(x => x.disabled = value) }
function logout() { userToken = ''; displayName = ''; localStorage.removeItem('guji_user_token'); localStorage.removeItem('guji_nickname'); renderAuth() }

async function startApp() {
  renderLoading()
  const { data, error } = await supabase.rpc('get_workspace_tasks', { p_token: userToken })
  if (error) { if (error.message.includes('登录已失效')) return logout(); return renderSetupError(error.message) }
  tasks = ((data ?? []) as Task[]).map(normalizeTask)
  filtered = [...tasks]
  renderShell()
  loadCurrent()
}

function renderLoading() { app.innerHTML = '<div class="page-loading"><div class="auth-logo">古</div><span>正在连接标注数据库…</span></div>' }
function renderSetupError(message: string) {
  app.innerHTML = `<div class="page-loading error-box"><div class="auth-logo">古</div><b>数据库尚未初始化</b><span>${esc(message)}</span><small>请先在 Supabase SQL Editor 中执行项目的初始化 SQL，并导入 tasks.csv。</small><button id="logout" class="secondary">退出登录</button></div>`
  document.querySelector('#logout')!.addEventListener('click', logout)
}

function renderShell() {
  app.innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="brand-mark">古</span><div><strong>古籍 OCR 标注</strong><small id="progressText"></small></div></div>
    <div class="view-tabs"><button id="workspaceTab" class="active">标注工作台</button><button id="dashboardTab">进度概览</button></div>
    <div class="filters" id="filters"><select id="batchFilter"><option value="">全部批次</option><option>一期</option><option>二期</option><option>三期</option></select><select id="statusFilter"><option value="">全部状态</option>${selectOptions.任务状态.map(x => `<option>${x}</option>`).join('')}</select><input id="sampleSearch" placeholder="跳转编号，如 428" inputmode="numeric"></div>
    <div class="user-menu"><span>${esc(displayName)}</span><button id="logoutBtn" title="退出">退出</button></div>
  </header>
  <div id="mainView"></div><div id="saveSignal" class="save-signal" aria-live="polite"><i></i><span></span></div><div id="toast" class="toast"></div><div id="lightbox" class="lightbox" hidden><button id="closeLightbox">×</button><img alt="古籍大图"></div>`
  document.querySelector('#logoutBtn')!.addEventListener('click', logout)
  document.querySelector('#workspaceTab')!.addEventListener('click', () => switchMode(false))
  document.querySelector('#dashboardTab')!.addEventListener('click', () => switchMode(true))
  document.querySelector('#batchFilter')!.addEventListener('change', applyFilters)
  document.querySelector('#statusFilter')!.addEventListener('change', applyFilters)
  document.querySelector('#sampleSearch')!.addEventListener('keydown', e => { if ((e as KeyboardEvent).key === 'Enter') jumpToSample() })
  document.querySelector('#closeLightbox')!.addEventListener('click', closeLightbox)
  document.querySelector('#lightbox')!.addEventListener('click', e => { if ((e.target as HTMLElement).id === 'lightbox') closeLightbox() })
  window.onkeydown = event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(false) }
    if (!dashboardMode && event.altKey && event.key === 'ArrowLeft') navigate(-1)
    if (!dashboardMode && event.altKey && event.key === 'ArrowRight') navigate(1)
    if (!dashboardMode && event.altKey && /^[1-6]$/.test(event.key)) {
      event.preventDefault()
      const symbols=['□','=','。','、','【】','<>']
      insertSymbol(symbols[Number(event.key)-1])
    }
    if (event.key === 'Escape') closeLightbox()
  }
  renderWorkspace()
}

function renderWorkspace() {
  const savedSplit = localStorage.getItem('guji_split') || ''
  const splitValue = Number.parseFloat(savedSplit)
  const split = /^\d+(\.\d+)?%$/.test(savedSplit) && splitValue >= 35 && splitValue <= 70 ? savedSplit : '55%'
  if (split !== savedSplit) localStorage.removeItem('guji_split')
  document.querySelector('#mainView')!.innerHTML = `<main class="workspace" style="--left-pane:${split}">
    <section class="viewer"><div class="viewer-toolbar"><span id="imageTitle">图片</span><div><button id="zoomOut" title="缩小">−</button><button id="fitImage" title="完整显示图片">适应窗口</button><button id="zoomIn" title="放大">＋</button><button id="rotateImage" title="顺时针旋转">↻</button><button id="fullImage" title="全屏查看">全屏</button></div></div><div id="imageStage" class="image-stage" title="滚轮缩放，按住拖动图片"></div></section>
    <div id="splitter" class="splitter" title="拖动调整左右宽度"></div>
    <section class="editor"><div class="record-nav"><button id="prevBtn" class="secondary">← 上一条</button><button id="nextBtn" class="secondary">下一条 →</button></div><div id="editorBody" class="editor-body"></div><footer class="savebar"><span id="saveState">已同步</span><button id="saveBtn" class="secondary">保存</button><button id="saveNextBtn" class="primary">完成并下一条</button></footer></section>
  </main>`
  document.querySelector('#prevBtn')!.addEventListener('click', () => navigate(-1)); document.querySelector('#nextBtn')!.addEventListener('click', () => navigate(1))
  document.querySelector('#saveBtn')!.addEventListener('click', () => save(false)); document.querySelector('#saveNextBtn')!.addEventListener('click', () => save(true))
  document.querySelector('#zoomOut')!.addEventListener('click', () => setZoom(zoom / 1.18)); document.querySelector('#zoomIn')!.addEventListener('click', () => setZoom(zoom * 1.18)); document.querySelector('#fitImage')!.addEventListener('click', fitImage)
  document.querySelector('#rotateImage')!.addEventListener('click', () => { rotation = (rotation + 90) % 360; fitImage() }); document.querySelector('#fullImage')!.addEventListener('click', openLightbox)
  bindImageInteractions(); bindSplitter()
}

function switchMode(dashboard: boolean) {
  if (dirty && !confirm('当前修改尚未保存，确定离开吗？')) return
  dashboardMode = dashboard
  document.querySelector('#workspaceTab')!.classList.toggle('active', !dashboard); document.querySelector('#dashboardTab')!.classList.toggle('active', dashboard)
  ;(document.querySelector('#filters') as HTMLElement).style.visibility = dashboard ? 'hidden' : 'visible'
  if (dashboard) renderDashboard(); else { renderWorkspace(); loadCurrent() }
}

function applyFilters() {
  const batch = (document.querySelector('#batchFilter') as HTMLSelectElement).value, status = (document.querySelector('#statusFilter') as HTMLSelectElement).value
  const old = current()?.sample_id
  filtered = tasks.filter(x => (!batch || x.batch === batch) && (!status || x.status === status))
  currentIndex = Math.max(0, filtered.findIndex(x => x.sample_id === old))
  loadCurrent()
}

function loadCurrent() {
  if (!current()) {
    document.querySelector('#editorBody')!.innerHTML = '<div class="empty"><b>没有符合条件的任务</b><span>请调整筛选条件</span></div>'; document.querySelector('#imageStage')!.innerHTML = '<div class="empty light">暂无图片</div>'; updateProgress(); return
  }
  try {
    draft = normalizeTask(clone(current())); original = clone(draft); dirty = false; zoom = 1; rotation = 0; panX = 0; panY = 0; undoText = null
    draft.labels.制作方式 ||= '雕版刻本'
    draft.labels.栏数 ||= '一'
    draft.labels.字体 = Array.isArray(draft.labels.字体) ? (draft.labels.字体[0] || '楷书') : (draft.labels.字体 || '楷书')
    if (draft.labels.图文版面 === '纯文字') draft.labels.图文版面 = '无'
    renderImage(); renderEditor(); updateProgress()
  } catch (error) {
    console.error('加载标注页失败：', error)
    renderEditorError(error)
  }
}

function renderEditorError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  const body = document.querySelector('#editorBody')
  if (body) body.innerHTML = `<div class="editor-error"><b>此页标注内容加载失败</b><span>请刷新页面后重试；若仍出现，请将以下信息发给管理员：</span><code>${esc(message)}</code></div>`
  const stage = document.querySelector('#imageStage')
  if (stage && !stage.querySelector('img')) stage.innerHTML = '<div class="empty light">图片加载失败</div>'
}

function imageUrl(task = draft!) { return `${location.origin}${basePath}images/${encodeURIComponent(task.image_path)}` }
function renderImage() {
  const url = imageUrl(); document.querySelector('#imageTitle')!.textContent = `样本 ${draft!.sample_id} · ${draft!.original_filename}`
  document.querySelector('#imageStage')!.innerHTML = `<img id="mainImage" draggable="false" src="${url}" alt="样本 ${draft!.sample_id}">`
  const image = document.querySelector<HTMLImageElement>('#mainImage')!
  image.addEventListener('load', fitImage)
  image.addEventListener('dblclick', openLightbox)
}

function renderEditor() {
  const l = draft!.labels || {}
  document.querySelector('#editorBody')!.innerHTML = `
    <div class="record-head"><div><span class="eyebrow">当前样本</span><h1>#${draft!.sample_id}</h1></div><div class="badges"><span>${esc(draft!.batch)}</span><span class="status-${statusClass(draft!.status)}">${esc(draft!.status)}</span></div></div>
    <div class="annotator-note">${draft!.annotator_name ? `标注人：${esc(draft!.annotator_name)}` : '首次保存时自动记录当前标注人'}</div>
    ${textField('链接位置', l.链接位置, '请输入本条资料的来源链接（必填）')}
    ${renderOcrPreview()}
    <label class="field-label" for="correctedText">校订文本 <em>主要填写区</em></label><textarea id="correctedText" class="main-text" spellcheck="false">${esc(draft!.corrected_text)}</textarea>
    <div class="symbolbar"><span>校订符号</span>${[
      ['□','残损字'],['=','重文号'],['。','圈点。'],['、','圈点、'],['【】','小字【】'],['<>','批注<>']
    ].map(([value,label],i) => `<button data-symbol="${esc(value)}" title="快捷键 Alt+${i+1}">${esc(label)}</button>`).join('')}<button id="undoText" class="undo-button" disabled>↶ 撤销一步</button></div>
    <div id="missingHint" class="missing-hint"></div>
    <details open><summary><span>文本信息</span><small>内容来源与页面位置</small></summary><div class="details-body">${singleField('内容部类',l.内容部类)}${singleField('页面位置',l.页面位置)}${textField('疑难说明', l.疑难说明, '无法判断或需要说明的问题')}</div></details>
    <details open><summary><span>物质形态</span><small>制作、时代、地域、版式</small></summary><div class="details-body">${singleField('制作方式',l.制作方式)}${singleField('时代',l.时代)}${singleField('刻印地域',l.刻印地域)}${singleField('刻印单位',l.刻印单位)}${linePatternField(l.行款)}${singleField('栏数',l.栏数)}${singleField('界行',l.界行)}${singleField('版框',l.版框)}${multiField('鱼尾',l.鱼尾)}${singleField('版心',l.版心)}${singleField('象鼻',l.象鼻)}${singleField('书耳',l.书耳)}${singleField('字体',l.字体)}${singleField('图文版面',l.图文版面)}</div></details>
    <details open><summary><span>阅读与流通</span><small>批注圈点、印章、磨损、数字化</small></summary><div class="details-body">${multiField('阅读痕迹', l.阅读痕迹)}${singleField('印章',l.印章)}${multiField('磨损情况', l.磨损情况)}${multiField('数字化干扰', l.数字化干扰)}</div></details>
    <div class="optional-note">${textField('备注', l.备注, '可选，不填写也可以保存')}</div>`
  bindEditor(); updateSaveState(); updateMissingHint()
  document.querySelector<HTMLElement>('#editorBody')!.scrollTop = 0
}

const fieldTitles: Record<string,string> = { 内容部类:'内容来源（经史子集）', 页面位置:'位置来源', 制作方式:'制作方式与技术类型', 时代:'刻印时代', 图文版面:'图文', 阅读痕迹:'批注／圈点' }
const CUSTOM_PREFIX='其他：'
function singleField(name: string, value: Value | undefined) {
  const options=selectOptions[name],raw=String(value??''),isCustom=raw==='其他'||raw.startsWith('主观题：')||(!!raw&&!options.includes(raw)),custom=isCustom?raw.replace(/^(其他|主观题)：/,'').replace(/^(其他|主观题)$/,''):''
  return `<fieldset class="chip-field single-chip-field"><legend>${fieldTitles[name]||name}</legend><div>${options.map(x=>{const customOption=x==='其他',selected=customOption?isCustom:x===raw;return `<label class="chip ${selected?'selected':''}"><input type="radio" name="field-${name}" data-field="${name}" value="${customOption?'__custom__':x}" ${selected?'checked':''}><span>${x}</span></label>`}).join('')}</div><div class="custom-answer ${isCustom?'show':''}" data-custom-box="${name}"><input data-custom-single="${name}" value="${esc(custom)}" placeholder="请填写其他内容"></div></fieldset>`
}
function multiField(name: string, value: Value | undefined) {
  const options=multiOptions[name],values=Array.isArray(value)?value:[],customValue=values.find(x=>x==='其他'||x.startsWith('其他：')||x.startsWith('主观题：')||!options.includes(x))||'',custom=customValue.replace(/^(其他|主观题)：/,'').replace(/^(其他|主观题)$/,'');const set=new Set(values)
  return `<fieldset class="chip-field"><legend>${fieldTitles[name]||name}</legend><div>${options.map(x=>{const customOption=x==='其他',selected=customOption?!!customValue:set.has(x);return `<label class="chip ${selected?'selected':''}"><input type="checkbox" data-field="${name}" value="${customOption?'__custom__':x}" ${selected?'checked':''}><span>${x}</span></label>`}).join('')}</div><div class="custom-answer ${customValue?'show':''}" data-custom-box="${name}"><input data-custom-multi="${name}" value="${esc(custom)}" placeholder="请填写其他内容"></div></fieldset>`
}
function textField(name: string, value: Value | undefined, placeholder='') { return `<label class="control wide"><span>${name}</span><input data-field="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>` }
function linePatternField(value: Value | undefined) { return `<div class="line-pattern"><label class="control wide"><span>行款 <small>根据校订文本自动估算，可手动修改</small></span><input data-field="行款" value="${esc(value)}" placeholder="如：半页10行，行19字"></label><button type="button" id="estimatePattern">重新估算</button></div>` }

function renderOcrPreview() {
  const text = typeof draft!.ocr_initial === 'string' ? draft!.ocr_initial : ''
  if (!text) return ''
  let rawAlerts: unknown = draft!.bert_alerts
  if (typeof rawAlerts === 'string') { try { rawAlerts = JSON.parse(rawAlerts) } catch { rawAlerts = [] } }
  const alerts = Array.isArray(rawAlerts) ? rawAlerts.filter((x): x is BertAlert => !!x && typeof x === 'object' && Number.isFinite(Number((x as BertAlert).offset))) : []
  const byOffset = new Map(alerts.map(alert => [Number(alert.offset), alert]))
  const html = Array.from(text).map((char, offset) => {
    const alert = byOffset.get(offset)
    const probability = alert ? Number(alert.error_prob) : 0
    return alert ? `<mark title="BERT 疑似错误，概率 ${(probability * 100).toFixed(1)}%">${esc(char)}</mark>` : esc(char)
  }).join('')
  return `<section class="ocr-preview"><div class="ocr-preview-head"><span>OCR 初始识别</span><small>${alerts.length ? `BERT 标记 ${alerts.length} 处（仅供复核）` : 'BERT 未标记疑似错误'}</small></div><div class="ocr-preview-text">${html}</div></section>`
}

function bindEditor() {
  const body=document.querySelector('#editorBody')!,textarea=body.querySelector<HTMLTextAreaElement>('#correctedText')!
  textarea.addEventListener('beforeinput',()=>{undoText=textarea.value;updateUndoButton()})
  textarea.addEventListener('input',()=>{draft!.corrected_text=textarea.value;markDirty()})
  body.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[data-field]').forEach(el=>el.addEventListener('input',()=>{
    const name=el.dataset.field!
    if(el.type==='checkbox') updateMultiValue(name,body)
    else if(el.type==='radio') {
      body.querySelectorAll(`input[data-field="${name}"]`).forEach(x=>x.closest('.chip')?.classList.toggle('selected',(x as HTMLInputElement).checked))
      const custom=el.value==='__custom__',box=body.querySelector<HTMLElement>(`[data-custom-box="${name}"]`);box?.classList.toggle('show',custom)
      draft!.labels[name]=custom?CUSTOM_PREFIX+(box?.querySelector<HTMLInputElement>('input')?.value||''):el.value
    } else draft!.labels[name]=el.value
    markDirty()
  }))
  body.querySelectorAll<HTMLInputElement>('[data-custom-single]').forEach(el=>el.addEventListener('input',()=>{draft!.labels[el.dataset.customSingle!]=CUSTOM_PREFIX+el.value;markDirty()}))
  body.querySelectorAll<HTMLInputElement>('[data-custom-multi]').forEach(el=>el.addEventListener('input',()=>{updateMultiValue(el.dataset.customMulti!,body);markDirty()}))
  body.querySelectorAll<HTMLButtonElement>('[data-symbol]').forEach(b=>b.addEventListener('click',()=>insertSymbol(b.dataset.symbol!)))
  body.querySelectorAll<HTMLElement>('.ocr-preview-text mark').forEach(mark => mark.addEventListener('click', () => { mark.classList.add('dismissed'); mark.removeAttribute('title') }))
  body.querySelector('#undoText')?.addEventListener('click',undoLastText)
  body.querySelector('#estimatePattern')?.addEventListener('click', estimateLinePattern)
}

function updateMultiValue(name:string,body:Element){
  const checked=Array.from(body.querySelectorAll<HTMLInputElement>(`input[data-field="${name}"]:checked`)),customSelected=checked.some(x=>x.value==='__custom__'),box=body.querySelector<HTMLElement>(`[data-custom-box="${name}"]`)
  checked.forEach(x=>x.closest('.chip')?.classList.toggle('selected',x.checked));box?.classList.toggle('show',customSelected)
  const values=checked.filter(x=>x.value!=='__custom__').map(x=>x.value);if(customSelected)values.push(CUSTOM_PREFIX+(box?.querySelector<HTMLInputElement>('input')?.value||''));draft!.labels[name]=values
}

function estimateLinePattern(){
  const textarea=document.querySelector<HTMLTextAreaElement>('#correctedText'),image=document.querySelector<HTMLImageElement>('#mainImage');if(!textarea)return
  const lines=textarea.value.split(/\r?\n/).map(x=>x.replace(/<[^>]+>/g,'').trim()).filter(Boolean),lengths=lines.map(x=>Array.from(x).length).filter(x=>x>0)
  if(!lengths.length)return toast('当前文本没有可估算的内容',true)
  const counts=new Map<number,number>();lengths.filter(x=>x>=3).forEach(x=>counts.set(x,(counts.get(x)||0)+1));const typical=[...counts].sort((a,b)=>b[1]-a[1]||a[0]-b[0])[0]?.[0]||Math.round(lengths.reduce((a,b)=>a+b,0)/lengths.length)
  const mainLineCount=lengths.filter(x=>x>=typical*.6).length
  const wide=!!image&&image.naturalWidth/image.naturalHeight>=1.35,rowCount=Math.max(1,wide?Math.round(mainLineCount/2):mainLineCount)
  const result=`半页${rowCount}行，行${typical}字`
  draft!.labels.行款=result;const input=document.querySelector<HTMLInputElement>('input[data-field="行款"]');if(input)input.value=result;markDirty();toast('已根据当前校订文本估算行款')
}

function insertSymbol(symbol:string){
  const t=document.querySelector<HTMLTextAreaElement>('#correctedText')!,s=t.selectionStart,e=t.selectionEnd,selected=t.value.slice(s,e);undoText=t.value;let insert=symbol,caret=s+symbol.length
  if(symbol==='【】'){insert=`【${selected}】`;caret=s+1+selected.length}
  else if(symbol==='<>'){insert=`<${selected}>`;caret=s+1+selected.length}
  else if((symbol==='。'||symbol==='、')&&selected){insert=Array.from(selected).map(ch=>/\s/.test(ch)?ch:ch+symbol).join('');caret=s+insert.length}
  t.setRangeText(insert,s,e,'end');t.focus();t.setSelectionRange(caret,caret);draft!.corrected_text=t.value;updateUndoButton();markDirty()
}
function undoLastText(){const t=document.querySelector<HTMLTextAreaElement>('#correctedText');if(!t||undoText===null)return;t.value=undoText;undoText=null;draft!.corrected_text=t.value;t.focus();updateUndoButton();markDirty()}
function updateUndoButton(){const b=document.querySelector<HTMLButtonElement>('#undoText');if(b)b.disabled=undoText===null}
function markDirty(){dirty=true;updateSaveState();updateMissingHint()}
function updateSaveState(message?:string){const x=document.querySelector('#saveState');if(!x)return;x.textContent=message??(dirty?'有未保存修改':'已同步');x.className=dirty?'unsaved':''}

async function save(goNext:boolean){if(!draft||busy)return;const missing=missingAnnotations();if(missing.includes('链接位置')){toast('请先填写必填项：链接位置',true);return}if(goNext&&!confirmMissing('完成并进入下一张'))return;busy=true;toggleSave(true);updateSaveState('保存中…');showSaveSignal('saving','保存中…');try{
  const nextStatus=goNext?'已完成':draft.status==='待标注'?'标注中':draft.status
  const {data,error}=await supabase.rpc('save_workspace_task',{p_token:userToken,p_sample_id:draft.sample_id,p_revision:original!.revision,p_corrected_text:draft.corrected_text,p_status:nextStatus,p_labels:draft.labels,p_reviewer_note:draft.reviewer_note})
  if(error)throw error;const saved=(Array.isArray(data)?data[0]:data) as Task;if(!saved)throw new Error('保存失败')
  const pos=tasks.findIndex(x=>x.sample_id===draft!.sample_id);tasks[pos]=saved;const fpos=filtered.findIndex(x=>x.sample_id===draft!.sample_id);filtered[fpos]=saved;draft=clone(saved);original=clone(saved);dirty=false;updateSaveState('保存成功');showSaveSignal('saved','保存成功！');toast('标注已保存')
  if(goNext&&currentIndex<filtered.length-1){currentIndex++;loadCurrent()}
}catch(e){updateSaveState('保存失败');showSaveSignal('error','保存失败，请重试');toast((e as Error).message,true)}finally{busy=false;toggleSave(false)}}
function toggleSave(v:boolean){document.querySelectorAll<HTMLButtonElement>('#saveBtn,#saveNextBtn').forEach(x=>x.disabled=v)}
function showSaveSignal(state:'saving'|'saved'|'error',message:string){
  const el=document.querySelector<HTMLElement>('#saveSignal');if(!el)return
  window.clearTimeout(saveSignalTimer);el.className=`save-signal show ${state}`;el.querySelector('span')!.textContent=message
  if(state!=='saving')saveSignalTimer=window.setTimeout(()=>{el.classList.remove('show')},3200)
}
const annotationFields=['链接位置','内容部类','页面位置','制作方式','时代','刻印地域','刻印单位','行款','栏数','界行','版框','鱼尾','版心','象鼻','书耳','字体','图文版面','阅读痕迹','印章','磨损情况','数字化干扰']
function missingAnnotations(){if(!draft)return[];return annotationFields.filter(name=>{const value=draft!.labels[name];return value==null||value===''||(Array.isArray(value)&&value.length===0)||value===CUSTOM_PREFIX||(Array.isArray(value)&&value.some(x=>x===CUSTOM_PREFIX))}).map(name=>fieldTitles[name]||name)}
function updateMissingHint(){const el=document.querySelector('#missingHint');if(!el)return;const missing=missingAnnotations();el.textContent=missing.length?`尚有 ${missing.length} 项未标注：${missing.slice(0,5).join('、')}${missing.length>5?'…':''}`:'本条维度已标注完整';el.className=`missing-hint ${missing.length?'':'complete'}`}
function confirmMissing(action:string){const missing=missingAnnotations();return !missing.length||confirm(`还有 ${missing.length} 项未标注：\n${missing.join('、')}\n\n仍要${action}吗？`)}
function navigate(delta:number){const n=currentIndex+delta;if(n<0||n>=filtered.length)return toast(n<0?'已经是第一条':'已经是最后一条');const notices=[];if(dirty)notices.push('当前修改尚未保存');const missing=delta>0?missingAnnotations():[];if(missing.length)notices.push(`尚有 ${missing.length} 项未标注：${missing.join('、')}`);if(notices.length&&!confirm(`${notices.join('\n\n')}\n\n仍要切换吗？`))return;currentIndex=n;loadCurrent()}
function jumpToSample(){const n=Number((document.querySelector('#sampleSearch')as HTMLInputElement).value),i=filtered.findIndex(x=>x.sample_id===n);if(i<0)return toast('当前筛选范围内未找到该编号',true);if(dirty&&!confirm('当前修改尚未保存，确定跳转吗？'))return;currentIndex=i;loadCurrent()}
function updateProgress(){document.querySelector('#progressText')!.textContent=filtered.length?`${currentIndex+1} / ${filtered.length} · 总计 ${tasks.length} 条`:`0 / 0 · 总计 ${tasks.length} 条`;const p=document.querySelector<HTMLButtonElement>('#prevBtn'),n=document.querySelector<HTMLButtonElement>('#nextBtn');if(p)p.disabled=currentIndex<=0;if(n)n.disabled=currentIndex>=filtered.length-1}
function fitImage(){
  const image=document.querySelector<HTMLImageElement>('#mainImage'),stage=document.querySelector<HTMLElement>('#imageStage');if(!image||!stage||!image.naturalWidth)return
  const rotated=rotation%180!==0,w=rotated?image.naturalHeight:image.naturalWidth,h=rotated?image.naturalWidth:image.naturalHeight
  zoom=Math.min((stage.clientWidth-36)/w,(stage.clientHeight-36)/h,1);panX=0;panY=0;transformImage()
}
function setZoom(v:number){zoom=Math.min(5,Math.max(.08,v));transformImage()}
function transformImage(){const x=document.querySelector<HTMLImageElement>('#mainImage');if(x)x.style.transform=`translate(-50%,-50%) translate(${panX}px,${panY}px) scale(${zoom}) rotate(${rotation}deg)`}
function bindImageInteractions(){
  const stage=document.querySelector<HTMLElement>('#imageStage')!;let dragging=false,lastX=0,lastY=0
  stage.addEventListener('wheel',e=>{e.preventDefault();setZoom(zoom*(e.deltaY<0?1.12:.89))},{passive:false})
  stage.addEventListener('pointerdown',e=>{dragging=true;lastX=e.clientX;lastY=e.clientY;stage.setPointerCapture(e.pointerId);stage.classList.add('dragging')})
  stage.addEventListener('pointermove',e=>{if(!dragging)return;panX+=e.clientX-lastX;panY+=e.clientY-lastY;lastX=e.clientX;lastY=e.clientY;transformImage()})
  const end=()=>{dragging=false;stage.classList.remove('dragging')};stage.addEventListener('pointerup',end);stage.addEventListener('pointercancel',end)
}
function bindSplitter(){
  const split=document.querySelector<HTMLElement>('#splitter')!,workspace=document.querySelector<HTMLElement>('.workspace')!;let active=false
  split.addEventListener('pointerdown',e=>{active=true;split.setPointerCapture(e.pointerId);split.classList.add('active')})
  split.addEventListener('pointermove',e=>{if(!active)return;const r=workspace.getBoundingClientRect(),pct=Math.min(70,Math.max(35,(e.clientX-r.left)/r.width*100));workspace.style.setProperty('--left-pane',`${pct}%`);localStorage.setItem('guji_split',`${pct}%`);fitImage()})
  const end=()=>{active=false;split.classList.remove('active')};split.addEventListener('pointerup',end);split.addEventListener('pointercancel',end)
}
function openLightbox(){if(!draft)return;const x=document.querySelector<HTMLDivElement>('#lightbox')!;x.hidden=false;x.querySelector('img')!.src=imageUrl()}function closeLightbox(){const x=document.querySelector<HTMLDivElement>('#lightbox');if(x)x.hidden=true}
function statusClass(s:string){return s==='已完成'?'done':s==='有疑问'?'warn':s==='待复核'?'review':'todo'}
function toast(msg:string,error=false){const x=document.querySelector('#toast')!;x.textContent=msg;x.className=`toast show${error?' error':''}`;setTimeout(()=>x.className='toast',2400)}

function renderDashboard(){
  const counts: Record<string, number> = {}
  selectOptions.任务状态.forEach(s => { counts[s] = tasks.filter(x => x.status === s).length })
  const done=counts.已完成||0,rate=tasks.length?Math.round(done/tasks.length*100):0
  const batches=['一期','二期','三期'].map(b=>({name:b,count:tasks.filter(x=>x.batch===b).length}))
  const people=new Map<string,number>();tasks.forEach(x=>{if(x.annotator_name)people.set(x.annotator_name,(people.get(x.annotator_name)||0)+1)})
  document.querySelector('#mainView')!.innerHTML=`<main class="dashboard"><div class="dashboard-head"><div><span class="eyebrow">项目进度</span><h1>标注概览</h1></div><div class="completion"><b>${rate}%</b><span>完成率</span></div></div><section class="metric-grid"><article><span>样本总数</span><b>${tasks.length}</b></article><article><span>待标注</span><b>${counts.待标注||0}</b></article><article><span>待复核</span><b>${counts.待复核||0}</b></article><article><span>已完成</span><b>${done}</b></article></section><section class="chart-grid"><article class="panel"><h2>任务状态</h2>${selectOptions.任务状态.map(s=>bar(s,counts[s]||0,tasks.length)).join('')}</article><article class="panel"><h2>数据批次</h2>${batches.map(x=>bar(x.name,x.count,tasks.length)).join('')}</article><article class="panel"><h2>标注人任务量</h2>${[...people.entries()].sort((a,b)=>b[1]-a[1]).map(([n,c])=>bar(n,c,tasks.length)).join('')||'<p class="muted">尚无标注记录</p>'}</article></section></main>`
  document.querySelector('#progressText')!.textContent=`总计 ${tasks.length} 条 · 已完成 ${done} 条`
}
function bar(name:string,count:number,total:number){return `<div class="bar-row"><div><span>${esc(name)}</span><b>${count}</b></div><i><em style="width:${total?count/total*100:0}%"></em></i></div>`}

boot()
