import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { createWorker } from 'tesseract.js'
import { MARD_COLOR_BY_CODE, MARD_COLORS } from './data/mardColors'
import { supabase } from './lib/supabase'
import './App.css'

type Bounds = { x: number; y: number; width: number; height: number }
type InventoryLine = { id: string; code: string; count: string }
type ProjectStatus = 'planned' | 'completed' | 'cancelled'
type ProjectItem = { code: string; count: number }
type SavedProject = {
  id: string
  name: string
  total: number | null
  status: ProjectStatus
  image_path: string | null
  created_at: string
  bead_project_items: ProjectItem[]
  thumbnailUrl?: string
}
type InventoryRecord = { code: string; quantity: number }
type Page = 'scan' | 'inventory' | 'projects'

const STATUS_LABELS: Record<ProjectStatus, string> = {
  planned: '打算拼',
  completed: '拼完了',
  cancelled: '不拼了',
}

const DEFAULT_CROP_TOP = 65
const DEFAULT_CROP_HEIGHT = 35
const newLine = (): InventoryLine => ({ id: crypto.randomUUID(), code: '', count: '' })
const normalizeCode = (value: string) => value.toUpperCase().replace(/\s/g, '').replace(/^([A-Z]+)0+(\d+)$/, '$1$2')

function BeadMark() {
  return <div className="bead-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = url
  })
}

function cropImage(image: HTMLImageElement, bounds: Bounds, top: number, height: number) {
  const y = bounds.y + bounds.height * top / 100
  const cropHeight = bounds.height * height / 100
  const scale = Math.min(3, 1800 / bounds.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bounds.width * scale)
  canvas.height = Math.round(cropHeight * scale)
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, bounds.x, y, bounds.width, cropHeight, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

async function createThumbnail(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(image.naturalWidth * scale)
    canvas.height = Math.round(image.naturalHeight * scale)
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('缩略图生成失败')), 'image/jpeg', 0.82))
  } finally {
    URL.revokeObjectURL(url)
  }
}

function parseOcrText(text: string) {
  const pieces = text.toUpperCase().replace(/[|]/g, ' ').match(/[A-Z]{1,2}\s*\d{1,2}|(?<![A-Z0-9])\d{1,4}(?![A-Z0-9])/g) ?? []
  const lines: InventoryLine[] = []
  let code = ''
  for (const piece of pieces) {
    const compact = piece.replace(/\s/g, '')
    if (/^[A-Z]{1,2}\d{1,2}$/.test(compact)) code = compact
    else if (code && /^\d{1,4}$/.test(compact)) {
      lines.push({ id: crypto.randomUUID(), code, count: compact })
      code = ''
    }
  }
  return lines.filter((line, index, all) => all.findIndex((candidate) => normalizeCode(candidate.code) === normalizeCode(line.code)) === index)
}

function AuthPanel({ email, message, onEmail, onSend }: { email: string; message: string; onEmail: (value: string) => void; onSend: () => void }) {
  return <section className="auth-card">
    <span className="eyebrow">私人豆仓</span>
    <h2>登录后同步库存</h2>
    <p>输入邮箱，我们会发一封免密码登录邮件。</p>
    <div className="auth-form"><input type="email" value={email} placeholder="你的邮箱" onChange={(event) => onEmail(event.target.value)} /><button type="button" onClick={onSend}>发送登录链接</button></div>
    {message && <small>{message}</small>}
  </section>
}

function App() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [page, setPage] = useState<Page>('scan')
  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [projects, setProjects] = useState<SavedProject[]>([])
  const [inventory, setInventory] = useState<InventoryRecord[]>([])
  const [inventorySearch, setInventorySearch] = useState('')
  const [cloudMessage, setCloudMessage] = useState('')

  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [bounds, setBounds] = useState<Bounds | null>(null)
  const [cropTop, setCropTop] = useState(DEFAULT_CROP_TOP)
  const [cropHeight, setCropHeight] = useState(DEFAULT_CROP_HEIGHT)
  const [cropUrl, setCropUrl] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  const [rows, setRows] = useState<InventoryLine[]>([])
  const [total, setTotal] = useState('')
  const [ocrText, setOcrText] = useState('')
  const [projectName, setProjectName] = useState('未命名图纸')
  const [saveMessage, setSaveMessage] = useState('')

  async function loadProjects() {
    if (!supabase) return null
    const database = supabase
    const { data, error } = await database.from('bead_projects').select('id,name,total,status,image_path,created_at,bead_project_items(code,count)').order('created_at', { ascending: false })
    if (error) { setCloudMessage(`图纸读取失败：${error.message}`); return null }
    const loaded = (data ?? []) as SavedProject[]
    await Promise.all(loaded.map(async (project) => {
      if (!project.image_path) return
      const { data: signed } = await database.storage.from('project-images').createSignedUrl(project.image_path, 3600)
      project.thumbnailUrl = signed?.signedUrl
    }))
    setProjects(loaded)
    return loaded
  }

  async function loadInventory(userId: string) {
    if (!supabase) return false
    const { data, error } = await supabase.from('user_inventory').select('code,quantity')
    if (error) { setCloudMessage(`库存读取失败：${error.message}`); return false }
    const existing = new Map((data ?? []).map((row) => [normalizeCode(row.code), Number(row.quantity)]))
    const missing = MARD_COLORS.filter((color) => !existing.has(color.code)).map((color) => ({ user_id: userId, code: color.code, quantity: 1000 }))
    if (missing.length) {
      const { error: insertError } = await supabase.from('user_inventory').insert(missing)
      if (insertError) { setCloudMessage(`豆仓初始化失败：${insertError.message}`); return false }
      missing.forEach((row) => existing.set(row.code, row.quantity))
    }
    setInventory(MARD_COLORS.map((color) => ({ code: color.code, quantity: existing.get(color.code) ?? 1000 })))
    return true
  }

  async function loadCloudData(activeSession: Session) {
    setCloudMessage('正在同步豆仓…')
    const [loadedProjects, loadedInventory] = await Promise.all([loadProjects(), loadInventory(activeSession.user.id)])
    if (loadedProjects && loadedInventory) setCloudMessage('')
  }

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => { if (session) void loadCloudData(session) }, [session])
  useEffect(() => { if (imageUrl && bounds) void loadImage(imageUrl).then((image) => setCropUrl(cropImage(image, bounds, cropTop, cropHeight))) }, [bounds, cropHeight, cropTop, imageUrl])

  function handleFile(file?: File) {
    if (!file || !file.type.startsWith('image/')) return
    if (imageUrl) URL.revokeObjectURL(imageUrl)
    const url = URL.createObjectURL(file)
    setSourceFile(file)
    setImageUrl(url)
    setFileName(file.name)
    setProjectName(file.name.replace(/\.[^.]+$/, ''))
    setRows([])
    setTotal('')
    setOcrText('')
    setProgress('')
    setSaveMessage('')
    setCropTop(DEFAULT_CROP_TOP)
    setCropHeight(DEFAULT_CROP_HEIGHT)
    void loadImage(url).then((image) => setBounds({ x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }))
  }

  async function recognize() {
    if (!cropUrl) return
    setProgress('正在加载本地识别器…')
    try {
      const worker = await createWorker('eng', 1, { logger: (message) => { if (message.status === 'recognizing text') setProgress(`正在读取清单… ${Math.round(message.progress * 100)}%`) } })
      await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()[] ' })
      const { data } = await worker.recognize(cropUrl)
      await worker.terminate()
      const recognized = parseOcrText(data.text)
      setOcrText(data.text)
      setRows(recognized.length ? recognized : [newLine()])
      setProgress(recognized.length ? `已读出 ${recognized.length} 种颜色，请逐项确认。` : '没有可靠读出结果，请在下方手动补录。')
    } catch {
      setProgress('识别器未能启动，请检查网络后重试。')
    }
  }

  async function sendMagicLink() {
    if (!supabase || !email) return
    setAuthMessage('正在发送登录链接…')
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } })
    setAuthMessage(error ? `发送失败：${error.message}` : '登录链接已发送，请在邮箱中打开。')
  }

  async function saveProject() {
    if (!supabase || !session) return
    const merged = new Map<string, number>()
    rows.forEach((row) => {
      const code = normalizeCode(row.code)
      if (code && row.count !== '' && Number.isFinite(Number(row.count))) merged.set(code, (merged.get(code) ?? 0) + Number(row.count))
    })
    const items = [...merged].map(([code, count]) => ({ code, count }))
    if (!items.length) { setSaveMessage('至少补录一项色号和数量后才能保存。'); return }
    setSaveMessage('正在保存图纸和缩略图…')
    const { data: project, error } = await supabase.from('bead_projects').insert({ user_id: session.user.id, name: projectName.trim() || '未命名图纸', total: total ? Number(total) : null, status: 'planned' }).select('id').single()
    if (error || !project) { setSaveMessage(`保存失败：${error?.message ?? '未知错误'}`); return }
    const { error: itemsError } = await supabase.from('bead_project_items').insert(items.map((item) => ({ ...item, project_id: project.id })))
    if (itemsError) {
      await supabase.from('bead_projects').delete().eq('id', project.id)
      setSaveMessage(`明细保存失败：${itemsError.message}`)
      return
    }
    if (sourceFile) {
      try {
        const thumbnail = await createThumbnail(sourceFile)
        const imagePath = `${session.user.id}/${project.id}/thumbnail.jpg`
        const { error: uploadError } = await supabase.storage.from('project-images').upload(imagePath, thumbnail, { contentType: 'image/jpeg', upsert: true })
        if (uploadError) throw uploadError
        const { error: imagePathError } = await supabase.from('bead_projects').update({ image_path: imagePath }).eq('id', project.id)
        if (imagePathError) throw imagePathError
      } catch (error) {
        setSaveMessage(`图纸已保存，但缩略图失败：${error instanceof Error ? error.message : '未知错误'}`)
        await loadProjects()
        return
      }
    }
    setSaveMessage('已保存，状态默认为“打算拼”。')
    await loadProjects()
    setPage('projects')
  }

  async function updateProjectStatus(projectId: string, status: ProjectStatus) {
    if (!supabase) return
    const previous = projects
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, status } : project))
    const { error } = await supabase.from('bead_projects').update({ status }).eq('id', projectId)
    if (error) { setProjects(previous); setCloudMessage(`状态更新失败：${error.message}`) }
  }

  async function setInventoryQuantity(code: string, quantity: number) {
    if (!supabase || !session) return
    const next = Math.max(0, Math.round(quantity))
    const previous = inventory
    setInventory((current) => current.map((item) => item.code === code ? { ...item, quantity: next } : item))
    const { error } = await supabase.from('user_inventory').upsert({ user_id: session.user.id, code, quantity: next, updated_at: new Date().toISOString() })
    if (error) { setInventory(previous); setCloudMessage(`库存更新失败：${error.message}`) }
  }

  const sum = rows.reduce((value, row) => value + (Number(row.count) || 0), 0)
  const delta = total ? Number(total) - sum : 0
  const updateRow = (id: string, key: 'code' | 'count', value: string) => setRows((current) => current.map((row) => row.id === id ? { ...row, [key]: key === 'code' ? value.toUpperCase() : value.replace(/\D/g, '') } : row))

  const completedUsage = new Map<string, number>()
  const pendingUsage = new Map<string, number>()
  projects.forEach((project) => project.bead_project_items.forEach((item) => {
    const code = normalizeCode(item.code)
    if (project.status === 'completed') completedUsage.set(code, (completedUsage.get(code) ?? 0) + item.count)
    if (project.status === 'planned') pendingUsage.set(code, (pendingUsage.get(code) ?? 0) + item.count)
  }))
  const inventoryRows = inventory.map((item) => {
    const remaining = item.quantity - (completedUsage.get(item.code) ?? 0)
    const pending = pendingUsage.get(item.code) ?? 0
    return { ...item, remaining, pending, afterPending: remaining - pending, color: MARD_COLOR_BY_CODE.get(item.code) }
  }).filter((item) => item.code.includes(normalizeCode(inventorySearch))).sort((a, b) => a.remaining - b.remaining || a.afterPending - b.afterPending || a.code.localeCompare(b.code, undefined, { numeric: true }))

  return <main className="app-shell">
    <header className="site-header">
      <button className="brand" type="button" onClick={() => setPage('scan')}><BeadMark /><span>豆多多</span></button>
      {session ? <div className="account-pill"><span>{session.user.email}</span><button type="button" onClick={() => void supabase?.auth.signOut()}>退出</button></div> : <span className="local-badge"><b></b>识别在本机完成</span>}
    </header>

    <nav className="app-nav" aria-label="主要功能">
      <button className={page === 'scan' ? 'active' : ''} type="button" onClick={() => setPage('scan')}><span>＋</span>识别图纸</button>
      <button className={page === 'inventory' ? 'active' : ''} type="button" onClick={() => setPage('inventory')}><span>◫</span>我的豆仓</button>
      <button className={page === 'projects' ? 'active' : ''} type="button" onClick={() => setPage('projects')}><span>▤</span>我的图纸</button>
    </nav>

    {cloudMessage && <div className="cloud-message">{cloudMessage}</div>}

    {page === 'scan' && <>
      <section className="hero" id="top"><p className="eyebrow">拼豆库存小助手</p><h1>一张图纸，<br /><em>理清所有豆子。</em></h1><p className="hero-copy">读取图纸底部的用量清单，由你确认后保存。新图纸默认进入“打算拼”，不会立刻扣库存。</p></section>
      <section className="workspace" aria-labelledby="upload-title"><div className="section-heading"><div><span className="step">01</span><h2 id="upload-title">放入一张图纸</h2></div><p>JPG、PNG、截图均可</p></div>
        {!imageUrl ? <button className="drop-zone" type="button" onClick={() => fileInput.current?.click()}><span className="upload-icon" aria-hidden="true">↑</span><strong>选择图纸图片</strong><span>从相册上传，或拖入这里</span><small>识别在本机完成；保存时同步压缩缩略图</small></button> : <div className="scanner"><div className="image-summary"><div><span className="file-label">已选图纸</span><strong>{fileName}</strong></div><button className="text-button" type="button" onClick={() => fileInput.current?.click()}>换一张</button></div><div className="crop-preview">{cropUrl && <img src={cropUrl} alt="将被识别的用量清单区域" />}</div><div className="crop-controls"><div><label htmlFor="top">清单从原图的哪里开始</label><output>{cropTop}%</output></div><input id="top" type="range" min="0" max="95" value={cropTop} onChange={(event) => { const next = Number(event.target.value); setCropTop(next); setCropHeight((current) => Math.min(current, 100 - next)) }} /><div><label htmlFor="height">清单区域高度</label><output>{cropHeight}%</output></div><input id="height" type="range" min="5" max={100 - cropTop} value={cropHeight} onChange={(event) => setCropHeight(Number(event.target.value))} /></div><button className="primary-button" type="button" onClick={recognize} disabled={!cropUrl || progress.includes('正在')}><span>{progress.includes('正在') ? progress : '读取这块清单'}</span><b>→</b></button></div>}
        <input ref={fileInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handleFile(event.target.files?.[0])} />
      </section>
      {imageUrl && <section className="review" aria-labelledby="review-title"><div className="section-heading compact"><div><span className="step">02</span><h2 id="review-title">确认盘点结果</h2></div><p>{progress || '调好区域后开始识别'}</p></div>{rows.length > 0 && <><label className="project-name">图纸名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><div className="table-head"><span>标准色号</span><span>颗数</span><span></span></div><div className="inventory-table">{rows.map((row) => <div className="inventory-row" key={row.id}><input aria-label="色号" value={row.code} placeholder="例如 C20" onChange={(event) => updateRow(row.id, 'code', event.target.value)} /><input aria-label="颗数" inputMode="numeric" value={row.count} placeholder="数量" onChange={(event) => updateRow(row.id, 'count', event.target.value)} /><button type="button" aria-label={`删除 ${row.code || '该项'}`} onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}>×</button></div>)}</div><button type="button" className="add-row" onClick={() => setRows((current) => [...current, newLine()])}>+ 补一项</button><div className="total-check"><label>图纸总计 <input inputMode="numeric" value={total} placeholder="例如 192" onChange={(event) => setTotal(event.target.value.replace(/\D/g, ''))} /> 颗</label><strong>已录入 {sum} 颗</strong>{total && delta !== 0 && <p>相差 <b>{Math.abs(delta)}</b> 颗：可能有一项被水印遮住。</p>}{total && delta === 0 && <p className="good">总计一致，可以保存。</p>}</div>{session ? <div className="save-panel"><button className="primary-button" type="button" onClick={saveProject}>保存为“打算拼” <b>→</b></button>{saveMessage && <p>{saveMessage}</p>}</div> : <p className="save-hint">登录后才能保存到“我的图纸”。</p>}</>}{ocrText && <details><summary>查看原始 OCR 文本</summary><pre>{ocrText}</pre></details>}</section>}
      {!session && <AuthPanel email={email} message={authMessage} onEmail={setEmail} onSend={() => void sendMagicLink()} />}
    </>}

    {page === 'inventory' && <section className="page-view">
      <div className="page-title"><div><p className="eyebrow">221 色标准豆仓</p><h1>我的豆仓</h1></div><div className="big-count">{inventory.length}<small>色</small></div></div>
      {!session ? <AuthPanel email={email} message={authMessage} onEmail={setEmail} onSend={() => void sendMagicLink()} /> : <><div className="inventory-legend"><span><i className="solid"></i>实际剩余</span><span><i className="outline"></i>扣除 pending 后</span></div><label className="search-box"><span>⌕</span><input value={inventorySearch} placeholder="搜索色号，例如 A17" onChange={(event) => setInventorySearch(event.target.value)} /></label><div className="stock-list">{inventoryRows.map((item) => <article className={`stock-row ${item.afterPending < 0 ? 'shortage' : ''}`} key={item.code}><span className="color-swatch" style={{ background: item.color?.hex }}></span><div className="stock-code"><strong>{item.code}</strong><small>{item.pending ? `pending ${item.pending}` : '暂无 pending'}</small></div><div className="stock-balance"><strong>{item.remaining}</strong><small>之后 {item.afterPending}</small></div><div className="stock-controls"><button type="button" onClick={() => void setInventoryQuantity(item.code, item.quantity - 100)}>−100</button><input aria-label={`${item.code}实际库存`} inputMode="numeric" value={item.remaining} onChange={(event) => void setInventoryQuantity(item.code, (Number(event.target.value.replace(/\D/g, '')) || 0) + (completedUsage.get(item.code) ?? 0))} /><button type="button" onClick={() => void setInventoryQuantity(item.code, item.quantity + 100)}>+100</button></div></article>)}</div></>}
    </section>}

    {page === 'projects' && <section className="page-view">
      <div className="page-title"><div><p className="eyebrow">图纸与用量</p><h1>我的图纸</h1></div><div className="big-count">{projects.length}<small>张</small></div></div>
      {!session ? <AuthPanel email={email} message={authMessage} onEmail={setEmail} onSend={() => void sendMagicLink()} /> : projects.length === 0 ? <div className="empty-state"><BeadMark /><h2>还没有图纸</h2><p>识别并确认一张图纸后，它会出现在这里。</p><button type="button" onClick={() => setPage('scan')}>去识别第一张</button></div> : <div className="project-grid">{projects.map((project) => <article className="project-card" key={project.id}><div className="project-thumb">{project.thumbnailUrl ? <img src={project.thumbnailUrl} alt={`${project.name}缩略图`} /> : <div><BeadMark /><span>旧图纸无缩略图</span></div>}<span>{project.total ?? project.bead_project_items.reduce((value, item) => value + item.count, 0)} 颗</span></div><div className="project-body"><div className="project-heading"><div><small>{new Date(project.created_at).toLocaleDateString('zh-CN')}</small><h2>{project.name}</h2></div><select className={`status-select ${project.status}`} aria-label={`${project.name}状态`} value={project.status} onChange={(event) => void updateProjectStatus(project.id, event.target.value as ProjectStatus)}>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="project-items">{project.bead_project_items.sort((a, b) => normalizeCode(a.code).localeCompare(normalizeCode(b.code), undefined, { numeric: true })).map((item) => <span key={item.code}><i style={{ background: MARD_COLOR_BY_CODE.get(normalizeCode(item.code))?.hex }}></i><b>{normalizeCode(item.code)}</b>{item.count}</span>)}</div><p className="status-note">{project.status === 'planned' ? '已计入 pending，尚未扣库存' : project.status === 'completed' ? '已从实际剩余库存中扣除' : '不参与库存与 pending 计算'}</p></div></article>)}</div>}
    </section>}
  </main>
}

export default App
