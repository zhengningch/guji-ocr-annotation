import { createClient } from '@supabase/supabase-js'
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config'
import './style.css'

type Value = string | string[]
type Labels = Record<string, Value>
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
  revision: number
  updated_at: string
}

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
const app = document.querySelector<HTMLDivElement>('#app')!
const selectOptions: Record<string, string[]> = {
  任务状态: ['待标注', '标注中', '待复核', '已完成', '有疑问'],
  内容部类: ['经部', '史部', '子部', '集部', '其他', '不确定'],
  页面位置: ['封面', '牌记', '序', '跋', '目录', '正文', '其他', '不确定'],
  制作方式: ['雕版', '活字', '抄本', '稿本', '影印', '其他', '不确定'],
  时代: ['唐五代', '宋', '辽金', '元', '明', '清', '民国', '其他', '不确定'],
  国家地区: ['中国', '日本', '朝鲜半岛', '越南', '其他', '不确定'],
  刻印单位: ['官刻', '坊刻', '家刻', '寺院刻', '其他', '不确定'],
  界行: ['无界行', '乌丝栏', '朱丝栏', '其他', '不确定'],
  版框: ['无边栏', '四周单边', '四周双边', '左右单边', '左右双边', '其他', '不确定'],
  版心: ['有', '无', '不确定'], 书耳: ['有', '无', '不确定'],
  图文版面: ['纯文字', '图文混排', '复杂多栏', '图表类', '以图为主', '其他'],
  印章: ['无', '有但不转录', '纯印章样本', '不确定'],
  阅读顺序: ['从右到左', '从左到右', '复杂顺序', '不确定'],
}
const multiOptions: Record<string, string[]> = {
  鱼尾: ['无', '黑鱼尾', '白鱼尾', '花鱼尾', '单鱼尾', '双鱼尾', '三鱼尾', '顺鱼尾', '对鱼尾', '不确定'],
  字体: ['楷书', '行书', '草书', '隶书', '篆书', '混合', '不确定'],
  阅读痕迹: ['无', '批注', '圈点', '训读', '墨钉', '涂改删除', '其他'],
  磨损情况: ['无明显磨损', '水渍', '油污', '虫洞', '漏字', '透字', '模糊', '遮挡', '残损', '其他'],
  数字化干扰: ['无', '水印', '光照不均', '折痕', '倾斜', '形变', '屏幕拍摄', '扫描噪声', '裁切不全', '其他'],
  特殊文字: ['无', '异体字', '生僻字', '避讳字', '小篆', '未编码字符', '残损字', '古文符号', '其他'],
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
let dashboardMode = false

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const basePath = import.meta.env.BASE_URL
const current = () => filtered[currentIndex]
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

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
  tasks = (data ?? []) as Task[]
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
  <div id="mainView"></div><div id="toast" class="toast"></div><div id="lightbox" class="lightbox" hidden><button id="closeLightbox">×</button><img alt="古籍大图"></div>`
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
    if (event.key === 'Escape') closeLightbox()
  }
  renderWorkspace()
}

function renderWorkspace() {
  document.querySelector('#mainView')!.innerHTML = `<main class="workspace">
    <section class="viewer"><div class="viewer-toolbar"><span id="imageTitle">图片</span><div><button id="zoomOut">−</button><button id="fitImage">适应</button><button id="zoomIn">＋</button><button id="rotateImage">↻</button><button id="fullImage">全屏</button></div></div><div id="imageStage" class="image-stage"></div></section>
    <section class="editor"><div class="record-nav"><button id="prevBtn" class="secondary">← 上一条</button><button id="nextBtn" class="secondary">下一条 →</button></div><div id="editorBody" class="editor-body"></div><footer class="savebar"><span id="saveState">已同步</span><button id="saveBtn" class="secondary">保存</button><button id="saveNextBtn" class="primary">保存并下一条</button></footer></section>
  </main>`
  document.querySelector('#prevBtn')!.addEventListener('click', () => navigate(-1)); document.querySelector('#nextBtn')!.addEventListener('click', () => navigate(1))
  document.querySelector('#saveBtn')!.addEventListener('click', () => save(false)); document.querySelector('#saveNextBtn')!.addEventListener('click', () => save(true))
  document.querySelector('#zoomOut')!.addEventListener('click', () => setZoom(zoom - .15)); document.querySelector('#zoomIn')!.addEventListener('click', () => setZoom(zoom + .15)); document.querySelector('#fitImage')!.addEventListener('click', () => setZoom(1))
  document.querySelector('#rotateImage')!.addEventListener('click', () => { rotation = (rotation + 90) % 360; transformImage() }); document.querySelector('#fullImage')!.addEventListener('click', openLightbox)
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
  draft = clone(current()); original = clone(current()); dirty = false; zoom = 1; rotation = 0
  renderImage(); renderEditor(); updateProgress()
}

function imageUrl(task = draft!) { return `${location.origin}${basePath}images/${encodeURIComponent(task.image_path)}` }
function renderImage() {
  const url = imageUrl(); document.querySelector('#imageTitle')!.textContent = `样本 ${draft!.sample_id} · ${draft!.original_filename}`
  document.querySelector('#imageStage')!.innerHTML = `<img id="mainImage" src="${url}" alt="样本 ${draft!.sample_id}">`
  document.querySelector('#mainImage')!.addEventListener('dblclick', openLightbox)
}

function renderEditor() {
  const l = draft!.labels || {}
  document.querySelector('#editorBody')!.innerHTML = `
    <div class="record-head"><div><span class="eyebrow">当前样本</span><h1>#${draft!.sample_id}</h1></div><div class="badges"><span>${esc(draft!.batch)}</span><span class="status-${statusClass(draft!.status)}">${esc(draft!.status)}</span></div></div>
    <div class="annotator-note">${draft!.annotator_name ? `标注人：${esc(draft!.annotator_name)}` : '首次保存时自动记录当前标注人'}</div>
    <label class="field-label" for="correctedText">校订文本 <em>主要填写区</em></label><textarea id="correctedText" class="main-text" spellcheck="false">${esc(draft!.corrected_text)}</textarea>
    <div class="symbolbar"><span>快速插入</span>${['□','●','○','、','◎','=','-','~','【】','<note></note>','<ignore></ignore>'].map(x => `<button data-symbol="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <div class="essential-grid">${selectField('任务状态', draft!.status)}${selectField('页面位置', l.页面位置)}${selectField('图文版面', l.图文版面)}${selectField('阅读顺序', l.阅读顺序)}</div>
    ${multiField('特殊文字', l.特殊文字)}${multiField('阅读痕迹', l.阅读痕迹)}${multiField('磨损情况', l.磨损情况)}${multiField('数字化干扰', l.数字化干扰)}${textField('疑难说明', l.疑难说明, '无法判断或规范未覆盖的问题')}
    <details><summary><span>更多版本属性</span><small>时代、地域、版式等低频字段</small></summary><div class="details-body"><div class="essential-grid">${selectField('内容部类',l.内容部类)}${selectField('制作方式',l.制作方式)}${selectField('时代',l.时代)}${selectField('国家地区',l.国家地区)}${selectField('刻印单位',l.刻印单位)}${selectField('界行',l.界行)}${selectField('版框',l.版框)}${selectField('版心',l.版心)}${selectField('书耳',l.书耳)}${selectField('印章',l.印章)}</div>${multiField('鱼尾',l.鱼尾)}${multiField('字体',l.字体)}<div class="essential-grid">${textField('刻印地域',l.刻印地域)}${textField('行款',l.行款)}${textField('象鼻',l.象鼻)}</div></div></details>
    <details><summary><span>OCR 初稿与复核</span><small>需要对照时展开</small></summary><div class="details-body"><label class="field-label">OCR初稿</label><pre class="readonly-text">${esc(draft!.ocr_initial)}</pre>${textField('复核意见',draft!.reviewer_note)}</div></details>`
  bindEditor(); updateSaveState()
}

function selectField(name: string, value: Value | undefined) { const v=String(value??''); return `<label class="control"><span>${name}</span><select data-field="${name}"><option value="">未选择</option>${selectOptions[name].map(x=>`<option ${x===v?'selected':''}>${x}</option>`).join('')}</select></label>` }
function multiField(name: string, value: Value | undefined) { const set=new Set(Array.isArray(value)?value:[]); return `<fieldset class="chip-field"><legend>${name}</legend><div>${multiOptions[name].map(x=>`<label class="chip ${set.has(x)?'selected':''}"><input type="checkbox" data-field="${name}" value="${x}" ${set.has(x)?'checked':''}><span>${x}</span></label>`).join('')}</div></fieldset>` }
function textField(name: string, value: Value | undefined, placeholder='') { return `<label class="control wide"><span>${name}</span><input data-field="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}"></label>` }

function bindEditor() {
  const body=document.querySelector('#editorBody')!
  body.querySelector('#correctedText')!.addEventListener('input',e=>{draft!.corrected_text=(e.target as HTMLTextAreaElement).value; markDirty()})
  body.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[data-field]').forEach(el=>el.addEventListener('input',()=>{
    const name=el.dataset.field!
    if(name==='任务状态') draft!.status=el.value
    else if(name==='复核意见') draft!.reviewer_note=el.value
    else if(el.type==='checkbox') { draft!.labels[name]=Array.from(body.querySelectorAll<HTMLInputElement>(`input[data-field="${name}"]:checked`)).map(x=>x.value); el.closest('.chip')?.classList.toggle('selected',(el as HTMLInputElement).checked) }
    else draft!.labels[name]=el.value
    markDirty()
  }))
  body.querySelectorAll<HTMLButtonElement>('[data-symbol]').forEach(b=>b.addEventListener('click',()=>insertSymbol(b.dataset.symbol!)))
}

function insertSymbol(symbol:string){const t=document.querySelector<HTMLTextAreaElement>('#correctedText')!,s=t.selectionStart,e=t.selectionEnd,selected=t.value.slice(s,e);let insert=symbol,caret=s+symbol.length;if(symbol==='【】'){insert=`【${selected}】`;caret=s+1+selected.length}else if(symbol.includes('</')){const tag=symbol.slice(1,symbol.indexOf('>'));insert=`<${tag}>${selected}</${tag}>`;caret=s+tag.length+2+selected.length}t.setRangeText(insert,s,e,'end');t.focus();t.setSelectionRange(caret,caret);draft!.corrected_text=t.value;markDirty()}
function markDirty(){dirty=true;updateSaveState()}
function updateSaveState(message?:string){const x=document.querySelector('#saveState');if(!x)return;x.textContent=message??(dirty?'有未保存修改':'已同步');x.className=dirty?'unsaved':''}

async function save(goNext:boolean){if(!draft||busy)return;busy=true;toggleSave(true);try{
  const {data,error}=await supabase.rpc('save_workspace_task',{p_token:userToken,p_sample_id:draft.sample_id,p_revision:original!.revision,p_corrected_text:draft.corrected_text,p_status:draft.status,p_labels:draft.labels,p_reviewer_note:draft.reviewer_note})
  if(error)throw error;const saved=(Array.isArray(data)?data[0]:data) as Task;if(!saved)throw new Error('保存失败')
  const pos=tasks.findIndex(x=>x.sample_id===draft!.sample_id);tasks[pos]=saved;const fpos=filtered.findIndex(x=>x.sample_id===draft!.sample_id);filtered[fpos]=saved;draft=clone(saved);original=clone(saved);dirty=false;updateSaveState('保存成功');toast('标注已保存')
  if(goNext&&currentIndex<filtered.length-1){currentIndex++;loadCurrent()}
}catch(e){updateSaveState('保存失败');toast((e as Error).message,true)}finally{busy=false;toggleSave(false)}}
function toggleSave(v:boolean){document.querySelectorAll<HTMLButtonElement>('#saveBtn,#saveNextBtn').forEach(x=>x.disabled=v)}
function navigate(delta:number){if(dirty&&!confirm('当前修改尚未保存，确定离开吗？'))return;const n=currentIndex+delta;if(n<0||n>=filtered.length)return toast(n<0?'已经是第一条':'已经是最后一条');currentIndex=n;loadCurrent()}
function jumpToSample(){const n=Number((document.querySelector('#sampleSearch')as HTMLInputElement).value),i=filtered.findIndex(x=>x.sample_id===n);if(i<0)return toast('当前筛选范围内未找到该编号',true);if(dirty&&!confirm('当前修改尚未保存，确定跳转吗？'))return;currentIndex=i;loadCurrent()}
function updateProgress(){document.querySelector('#progressText')!.textContent=filtered.length?`${currentIndex+1} / ${filtered.length} · 总计 ${tasks.length} 条`:`0 / 0 · 总计 ${tasks.length} 条`;const p=document.querySelector<HTMLButtonElement>('#prevBtn'),n=document.querySelector<HTMLButtonElement>('#nextBtn');if(p)p.disabled=currentIndex<=0;if(n)n.disabled=currentIndex>=filtered.length-1}
function setZoom(v:number){zoom=Math.min(4,Math.max(.3,v));transformImage()}function transformImage(){const x=document.querySelector<HTMLImageElement>('#mainImage');if(x)x.style.transform=`scale(${zoom}) rotate(${rotation}deg)`}
function openLightbox(){if(!draft)return;const x=document.querySelector<HTMLDivElement>('#lightbox')!;x.hidden=false;x.querySelector('img')!.src=imageUrl()}function closeLightbox(){const x=document.querySelector<HTMLDivElement>('#lightbox');if(x)x.hidden=true}
function statusClass(s:string){return s==='已完成'?'done':s==='有疑问'?'warn':s==='待复核'?'review':'todo'}
function toast(msg:string,error=false){const x=document.querySelector('#toast')!;x.textContent=msg;x.className=`toast show${error?' error':''}`;setTimeout(()=>x.className='toast',2400)}

function renderDashboard(){
  const counts=Object.fromEntries(selectOptions.任务状态.map(s=>[s,tasks.filter(x=>x.status===s).length]));const done=counts.已完成||0,rate=tasks.length?Math.round(done/tasks.length*100):0
  const batches=['一期','二期','三期'].map(b=>({name:b,count:tasks.filter(x=>x.batch===b).length}))
  const people=new Map<string,number>();tasks.forEach(x=>{if(x.annotator_name)people.set(x.annotator_name,(people.get(x.annotator_name)||0)+1)})
  document.querySelector('#mainView')!.innerHTML=`<main class="dashboard"><div class="dashboard-head"><div><span class="eyebrow">项目进度</span><h1>标注概览</h1></div><div class="completion"><b>${rate}%</b><span>完成率</span></div></div><section class="metric-grid"><article><span>样本总数</span><b>${tasks.length}</b></article><article><span>待标注</span><b>${counts.待标注||0}</b></article><article><span>待复核</span><b>${counts.待复核||0}</b></article><article><span>已完成</span><b>${done}</b></article></section><section class="chart-grid"><article class="panel"><h2>任务状态</h2>${selectOptions.任务状态.map(s=>bar(s,counts[s]||0,tasks.length)).join('')}</article><article class="panel"><h2>数据批次</h2>${batches.map(x=>bar(x.name,x.count,tasks.length)).join('')}</article><article class="panel"><h2>标注人任务量</h2>${[...people.entries()].sort((a,b)=>b[1]-a[1]).map(([n,c])=>bar(n,c,tasks.length)).join('')||'<p class="muted">尚无标注记录</p>'}</article></section></main>`
  document.querySelector('#progressText')!.textContent=`总计 ${tasks.length} 条 · 已完成 ${done} 条`
}
function bar(name:string,count:number,total:number){return `<div class="bar-row"><div><span>${esc(name)}</span><b>${count}</b></div><i><em style="width:${total?count/total*100:0}%"></em></i></div>`}

boot()
