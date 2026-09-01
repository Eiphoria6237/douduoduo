import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import ReactCrop, { type PercentCrop } from 'react-image-crop'
import { MARD_COLOR_BY_CODE, MARD_COLORS } from './data/mardColors'
import { supabase } from './lib/supabase'
import 'react-image-crop/dist/ReactCrop.css'
import './App.css'

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
type RecognitionItem = { code: string; count: number }

const STATUS_LABELS: Record<ProjectStatus, string> = {
  planned: '打算拼',
  completed: '拼完了',
  cancelled: '不拼了',
}

const DEFAULT_CROP: PercentCrop = { unit: '%', x: 4, y: 68, width: 92, height: 28 }
const DEFAULT_REPLENISHMENT_LINE = 500
const HIGH_USE_COLORS = new Set(['H1', 'H2', 'H7'])
const newLine = (): InventoryLine => ({ id: crypto.randomUUID(), code: '', count: '' })
const normalizeCode = (value: string) => value.toUpperCase().replace(/\s/g, '').replace(/^([A-Z]+)0+(\d+)$/, '$1$2')
const compareCodes = (first: string, second: string) => first.localeCompare(second, undefined, { numeric: true })
const replenishmentLine = (code: string) => HIGH_USE_COLORS.has(code) ? 2000 : DEFAULT_REPLENISHMENT_LINE

function BeadMark() {
  return <div className="bead-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = url
  })
}

async function createColorMask(url: string, hex: string) {
  const image = await loadImage(url)
  const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const target = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16))
  const lightness = (target[0] + target[1] + target[2]) / 3
  const threshold = lightness > 235 ? 28 : lightness < 40 ? 48 : 62

  for (let index = 0; index < pixels.data.length; index += 4) {
    const red = pixels.data[index] - target[0]
    const green = pixels.data[index + 1] - target[1]
    const blue = pixels.data[index + 2] - target[2]
    const distance = Math.sqrt(red * red * .3 + green * green * .59 + blue * blue * .11)
    pixels.data[index] = 255
    pixels.data[index + 1] = 255
    pixels.data[index + 2] = 255
    pixels.data[index + 3] = distance <= threshold ? 255 : 0
  }
  context.putImageData(pixels, 0, 0)
  return canvas.toDataURL('image/png')
}

function cropImage(image: HTMLImageElement, crop: PercentCrop) {
  const bounds = {
    x: image.naturalWidth * crop.x / 100,
    y: image.naturalHeight * crop.y / 100,
    width: image.naturalWidth * crop.width / 100,
    height: image.naturalHeight * crop.height / 100,
  }
  const scale = Math.min(4, 2600 / bounds.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bounds.width * scale)
  canvas.height = Math.round(bounds.height * scale)
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

async function createWorkingImage(file: File) {
  const url = URL.createObjectURL(file)
  try {
    const image = await loadImage(url)
    const scale = Math.min(1, 3200 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(image.naturalWidth * scale)
    canvas.height = Math.round(image.naturalHeight * scale)
    const context = canvas.getContext('2d')!
    context.fillStyle = '#fff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图纸生成失败')), 'image/jpeg', 0.9))
  } finally {
    URL.revokeObjectURL(url)
  }
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
  const inventorySeries = useRef<Record<string, HTMLDetailsElement | null>>({})
  const [page, setPage] = useState<Page>('scan')
  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [projects, setProjects] = useState<SavedProject[]>([])
  const [inventory, setInventory] = useState<InventoryRecord[]>([])
  const [inventorySearch, setInventorySearch] = useState('')
  const [cloudMessage, setCloudMessage] = useState('')
  const [openProject, setOpenProject] = useState<SavedProject | null>(null)
  const [viewerZoom, setViewerZoom] = useState(100)
  const [highlightCode, setHighlightCode] = useState<string | null>(null)
  const [highlightMask, setHighlightMask] = useState<string | null>(null)
  const [highlightMessage, setHighlightMessage] = useState('')
  const maskRequest = useRef(0)

  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [cropSelection, setCropSelection] = useState<PercentCrop>(DEFAULT_CROP)
  const [isCropping, setIsCropping] = useState(false)
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
    if (!supabase) return null
    const { data, error } = await supabase.from('user_inventory').select('code,quantity')
    if (error) { setCloudMessage(`库存读取失败：${error.message}`); return null }
    const existing = new Map((data ?? []).map((row) => [normalizeCode(row.code), Number(row.quantity)]))
    const missing = MARD_COLORS.filter((color) => !existing.has(color.code)).map((color) => ({ user_id: userId, code: color.code, quantity: 1000 }))
    if (missing.length) {
      const { error: insertError } = await supabase.from('user_inventory').insert(missing)
      if (insertError) { setCloudMessage(`豆仓初始化失败：${insertError.message}`); return null }
      missing.forEach((row) => existing.set(row.code, row.quantity))
    }
    const loaded = MARD_COLORS.map((color) => ({ code: color.code, quantity: existing.get(color.code) ?? 1000 }))
    setInventory(loaded)
    return loaded
  }

  async function loadCloudData(activeSession: Session) {
    setCloudMessage('正在同步豆仓…')
    const [loadedProjects, loadedInventory] = await Promise.all([loadProjects(), loadInventory(activeSession.user.id)])
    if (loadedProjects && loadedInventory) {
      setCloudMessage('')
    }
  }

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => { if (session) void loadCloudData(session) }, [session])

  useEffect(() => {
    if (!openProject) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenProject(null) }
    document.body.classList.add('viewer-open')
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.classList.remove('viewer-open')
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [openProject])

  function showProject(project: SavedProject) {
    if (!project.thumbnailUrl) return
    setViewerZoom(100)
    setHighlightCode(null)
    setHighlightMask(null)
    setHighlightMessage('')
    setOpenProject(project)
  }

  async function selectHighlight(code: string) {
    if (!openProject?.thumbnailUrl) return
    if (highlightCode === code) {
      maskRequest.current += 1
      setHighlightCode(null)
      setHighlightMask(null)
      setHighlightMessage('')
      return
    }
    const color = MARD_COLOR_BY_CODE.get(code)
    if (!color) return
    const request = ++maskRequest.current
    setHighlightCode(code)
    setHighlightMask(null)
    setHighlightMessage(`正在寻找 ${code}…`)
    try {
      const mask = await createColorMask(openProject.thumbnailUrl, color.hex)
      if (request !== maskRequest.current) return
      setHighlightMask(mask)
      setHighlightMessage('')
    } catch {
      if (request !== maskRequest.current) return
      setHighlightCode(null)
      setHighlightMessage('这张图纸无法在本地分析颜色。')
    }
  }

  function handleFile(file?: File) {
    if (!file || !file.type.startsWith('image/')) return
    if (imageUrl) URL.revokeObjectURL(imageUrl)
    const url = URL.createObjectURL(file)
    setSourceFile(file)
    setImageUrl(url)
    setCropUrl(null)
    setCropSelection(DEFAULT_CROP)
    setIsCropping(true)
    setFileName(file.name)
    setProjectName(file.name.replace(/\.[^.]+$/, ''))
    setRows([])
    setTotal('')
    setOcrText('')
    setProgress('')
    setSaveMessage('')
  }

  async function confirmCrop() {
    if (!imageUrl || cropSelection.width < 2 || cropSelection.height < 2) return
    const image = await loadImage(imageUrl)
    setCropUrl(cropImage(image, cropSelection))
    setIsCropping(false)
    setRows([])
    setOcrText('')
    setProgress('清单范围已确认，可以开始识别。')
  }

  async function recognize() {
    if (!cropUrl) return
    if (!supabase) {
      setProgress('尚未配置 Supabase，无法使用 AI 识别。')
      return
    }
    if (!session) {
      setProgress('请先登录，再使用 AI 识别。')
      return
    }
    setProgress('正在使用 AI 读取清单…')
    try {
      const { data, error } = await supabase.functions.invoke<{ items?: unknown }>('recognize-legend', {
        body: { imageDataUrl: cropUrl },
      })
      if (error) throw error
      if (!Array.isArray(data?.items)) throw new Error('服务返回格式不正确')

      const seen = new Set<string>()
      const recognized = data.items.flatMap((value): RecognitionItem[] => {
        if (!value || typeof value !== 'object') return []
        const item = value as Partial<RecognitionItem>
        const code = normalizeCode(typeof item.code === 'string' ? item.code : '')
        if (!MARD_COLOR_BY_CODE.has(code) || !Number.isInteger(item.count) || Number(item.count) < 0 || seen.has(code)) return []
        seen.add(code)
        return [{ code, count: Number(item.count) }]
      })
      setOcrText(JSON.stringify({ items: recognized }, null, 2))
      setRows(recognized.length ? recognized.map((item) => ({ id: crypto.randomUUID(), code: item.code, count: String(item.count) })) : [newLine()])
      setProgress(recognized.length ? `AI 已读出 ${recognized.length} 种颜色，请逐项确认。` : 'AI 没有读出可靠结果，请重新裁切或手动补录。')
    } catch (error) {
      setProgress(`AI 识别失败：${error instanceof Error ? error.message : '请稍后重试'}`)
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
    setSaveMessage('正在保存用量和高清图纸…')
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
        const workingImage = await createWorkingImage(sourceFile)
        const imagePath = `${session.user.id}/${project.id}/chart.jpg`
        const { error: uploadError } = await supabase.storage.from('project-images').upload(imagePath, workingImage, { contentType: 'image/jpeg', upsert: true })
        if (uploadError) throw uploadError
        const { error: imagePathError } = await supabase.from('bead_projects').update({ image_path: imagePath }).eq('id', project.id)
        if (imagePathError) throw imagePathError
      } catch (error) {
        setSaveMessage(`用量已保存，但高清图纸上传失败：${error instanceof Error ? error.message : '未知错误'}`)
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

  function jumpToInventorySeries(code: string) {
    setInventorySearch('')
    requestAnimationFrame(() => {
      const section = inventorySeries.current[code[0]]
      if (!section) return
      section.open = true
      section.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
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
  const inventoryValues = inventory.map((item) => {
    const remaining = item.quantity - (completedUsage.get(item.code) ?? 0)
    const pending = pendingUsage.get(item.code) ?? 0
    const afterPending = remaining - pending
    const line = replenishmentLine(item.code)
    return { ...item, remaining, pending, afterPending, line, pickup: Math.max(0, line - afterPending), color: MARD_COLOR_BY_CODE.get(item.code) }
  }).sort((first, second) => compareCodes(first.code, second.code))
  const pickupItems = inventoryValues.filter((item) => item.afterPending < item.line)
  const inventoryQuery = normalizeCode(inventorySearch)
  const inventoryGroups = [...new Set(MARD_COLORS.map((color) => color.code[0]))].map((series) => ({
    series,
    items: inventoryValues.filter((item) => item.code.startsWith(series) && item.code.includes(inventoryQuery)),
    palette: MARD_COLORS.filter((color) => color.code.startsWith(series)),
  })).filter((group) => group.items.length > 0)

  return <main className="app-shell">
    <header className="site-header">
      <button className="brand" type="button" onClick={() => setPage('scan')}><BeadMark /><span>豆多多</span></button>
      {session ? <div className="account-pill"><span>{session.user.email}</span><button type="button" onClick={() => void supabase?.auth.signOut()}>退出</button></div> : <span className="local-badge"><b></b>登录后使用 AI 识别</span>}
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
        {!imageUrl ? <button className="drop-zone" type="button" onClick={() => fileInput.current?.click()}><span className="upload-icon" aria-hidden="true">↑</span><strong>选择图纸图片</strong><span>从相册上传，或拖入这里</span><small>裁切清单将发送给 OpenAI；完整图纸保存后可直接打开</small></button> : <div className="scanner">
          <div className="image-summary"><div><span className="file-label">已选图纸</span><strong>{fileName}</strong></div><button className="text-button" type="button" onClick={() => fileInput.current?.click()}>换一张</button></div>
          {isCropping ? <>
            <div className="crop-instruction"><strong>圈出整块用量清单</strong><span>拖动选框，拉动边角调整大小，左右色号都要包进去。</span></div>
            <div className="crop-stage"><ReactCrop crop={cropSelection} onChange={(_pixelCrop, percentCrop) => setCropSelection(percentCrop)} minWidth={40} minHeight={24} keepSelection ruleOfThirds><img src={imageUrl} alt="请裁出用量清单" /></ReactCrop></div>
            <button className="primary-button" type="button" onClick={() => void confirmCrop()}><span>确认清单范围</span><b>✓</b></button>
          </> : <>
            <div className="crop-preview">{cropUrl && <img src={cropUrl} alt="将被识别的用量清单区域" />}</div>
            <div className="crop-ready"><span>AI 只接收上方裁切清单；保存时会另存完整高清图纸。</span><button className="text-button" type="button" onClick={() => setIsCropping(true)}>重新裁切</button></div>
            <button className="primary-button" type="button" onClick={recognize} disabled={!cropUrl || progress.includes('正在')}><span>{progress.includes('正在') ? progress : '读取这块清单'}</span><b>→</b></button>
          </>}
        </div>}
        <input ref={fileInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handleFile(event.target.files?.[0])} />
      </section>
      {imageUrl && <section className="review" aria-labelledby="review-title"><div className="section-heading compact"><div><span className="step">02</span><h2 id="review-title">确认盘点结果</h2></div><p>{progress || '调好区域后开始识别'}</p></div>{rows.length > 0 && <><label className="project-name">图纸名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><div className="table-head"><span>标准色号</span><span>颗数</span><span></span></div><div className="inventory-table">{rows.map((row) => <div className="inventory-row" key={row.id}><input aria-label="色号" value={row.code} placeholder="例如 C20" onChange={(event) => updateRow(row.id, 'code', event.target.value)} /><input aria-label="颗数" inputMode="numeric" value={row.count} placeholder="数量" onChange={(event) => updateRow(row.id, 'count', event.target.value)} /><button type="button" aria-label={`删除 ${row.code || '该项'}`} onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}>×</button></div>)}</div><button type="button" className="add-row" onClick={() => setRows((current) => [...current, newLine()])}>+ 补一项</button><div className="total-check"><label>图纸总计（选填） <input inputMode="numeric" value={total} placeholder="可不填" onChange={(event) => setTotal(event.target.value.replace(/\D/g, ''))} /> 颗</label><strong>已录入 {sum} 颗</strong>{total && delta !== 0 && <p>相差 <b>{Math.abs(delta)}</b> 颗：可能有一项被水印遮住。</p>}{total && delta === 0 && <p className="good">总计一致，可以保存。</p>}</div>{session ? <div className="save-panel"><button className="primary-button" type="button" onClick={saveProject}>保存为“打算拼” <b>→</b></button>{saveMessage && <p>{saveMessage}</p>}</div> : <p className="save-hint">登录后才能保存到“我的图纸”。</p>}</>}{ocrText && <details><summary>查看 AI 返回数据</summary><pre>{ocrText}</pre></details>}</section>}
      {!session && <AuthPanel email={email} message={authMessage} onEmail={setEmail} onSend={() => void sendMagicLink()} />}
    </>}

    {page === 'inventory' && <section className="page-view">
      <div className="page-title"><div><p className="eyebrow">221 色标准豆仓</p><h1>我的豆仓</h1></div><div className="big-count">{inventory.length}<small>色</small></div></div>
      {!session ? <AuthPanel email={email} message={authMessage} onEmail={setEmail} onSend={() => void sendMagicLink()} /> : <>
        {pickupItems.length > 0 && <section className="pickup-panel" aria-labelledby="pickup-title">
          <div className="pickup-heading"><div><span className="step">PICKUP</span><h2 id="pickup-title">需要补豆</h2></div><strong>{pickupItems.length}<small> 色</small></strong></div>
          <div className="pickup-grid">{pickupItems.map((item) => <button className="pickup-card" type="button" key={item.code} onClick={() => jumpToInventorySeries(item.code)}>
            <strong>{item.code}</strong><span>计划后 {item.afterPending}</span>
          </button>)}</div>
        </section>}

        <div className="inventory-browser">
          <div className="inventory-browser-heading"><div><span className="step">ALL COLORS</span><h2>按系列查看</h2></div><span>点击系列展开库存</span></div>
          <label className="search-box"><span>⌕</span><input value={inventorySearch} placeholder="搜索色号，例如 A17" onChange={(event) => setInventorySearch(event.target.value)} /></label>
          <div className="color-series-list">{inventoryGroups.map((group) => <details className="color-series" key={group.series} ref={(section) => { inventorySeries.current[group.series] = section }} open={inventoryQuery ? true : undefined}>
            <summary>
              <div className="series-cover" aria-hidden="true">{group.palette.map((color) => <i key={color.code} style={{ background: color.hex }}></i>)}</div>
              <div className="series-title"><strong>{group.series} 系列</strong><span>{group.palette[0]?.code}–{group.palette.at(-1)?.code}</span></div>
              <div className="series-meta"><b>{group.items.length}</b><small>色</small></div>
              <span className="series-arrow">⌄</span>
            </summary>
            <div className="series-stock-grid">{group.items.map((item) => <article className={`color-stock-card ${item.afterPending < item.line ? 'below-line' : ''}`} key={item.code}>
              <div className="stock-color-face" style={{ background: item.color?.hex }}><strong>{item.code}</strong>{item.afterPending < item.line && <span>待补 +{item.pickup}</span>}</div>
              <div className="stock-plan"><div><small>计划完成后</small><strong>{item.afterPending}</strong></div><span><small>计划占用</small><b>{item.pending}</b></span></div>
              <div className="stock-editor"><span>现有库存</span><div className="stock-controls"><button type="button" aria-label={`${item.code} 减少1000`} onClick={() => void setInventoryQuantity(item.code, item.quantity - 1000)}>−1000</button><input aria-label={`${item.code}实际库存`} inputMode="numeric" value={item.remaining} onChange={(event) => void setInventoryQuantity(item.code, (Number(event.target.value.replace(/\D/g, '')) || 0) + (completedUsage.get(item.code) ?? 0))} /><button type="button" aria-label={`${item.code} 增加1000`} onClick={() => void setInventoryQuantity(item.code, item.quantity + 1000)}>+1000</button></div></div>
            </article>)}</div>
          </details>)}</div>
          {!inventoryGroups.length && <div className="pickup-clear">没有找到“{inventorySearch}”。</div>}
        </div>
      </>}
    </section>}

    {page === 'projects' && <section className="page-view">
      <div className="page-title"><div><p className="eyebrow">图纸与用量</p><h1>我的图纸</h1></div><div className="big-count">{projects.length}<small>张</small></div></div>
      {!session ? <AuthPanel email={email} message={authMessage} onEmail={setEmail} onSend={() => void sendMagicLink()} /> : projects.length === 0 ? <div className="empty-state"><BeadMark /><h2>还没有图纸</h2><p>识别并确认一张图纸后，它会出现在这里。</p><button type="button" onClick={() => setPage('scan')}>去识别第一张</button></div> : <div className="project-grid">{projects.map((project) => <article className={`project-card ${project.thumbnailUrl ? 'clickable' : ''}`} key={project.id} tabIndex={project.thumbnailUrl ? 0 : undefined} onClick={() => showProject(project)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showProject(project) } }}><div className="project-thumb">{project.thumbnailUrl ? <img src={project.thumbnailUrl} alt={`${project.name}缩略图`} /> : <div><BeadMark /><span>旧图纸无缩略图</span></div>}<span>{project.total ?? project.bead_project_items.reduce((value, item) => value + item.count, 0)} 颗</span></div><div className="project-body"><div className="project-heading"><div><small>{new Date(project.created_at).toLocaleDateString('zh-CN')}</small><h2>{project.name}</h2></div><select className={`status-select ${project.status}`} aria-label={`${project.name}状态`} value={project.status} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()} onChange={(event) => void updateProjectStatus(project.id, event.target.value as ProjectStatus)}>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="project-items">{project.bead_project_items.sort((a, b) => normalizeCode(a.code).localeCompare(normalizeCode(b.code), undefined, { numeric: true })).map((item) => <span key={item.code}><i style={{ background: MARD_COLOR_BY_CODE.get(normalizeCode(item.code))?.hex }}></i><b>{normalizeCode(item.code)}</b>{item.count}</span>)}</div><p className="status-note">{project.status === 'planned' ? '已计入 pending，尚未扣库存' : project.status === 'completed' ? '已从实际剩余库存中扣除' : '不参与库存与 pending 计算'}</p></div></article>)}</div>}
    </section>}

    {openProject?.thumbnailUrl && <div className="chart-viewer" role="dialog" aria-modal="true" aria-label={`查看 ${openProject.name}`}>
      <header className="viewer-header"><div><span>正在拼</span><strong>{openProject.name}</strong></div><button type="button" aria-label="关闭图纸" onClick={() => setOpenProject(null)}>×</button></header>
      <div className="viewer-canvas"><div className="viewer-image-stage" style={{ width: `${viewerZoom}%` }}><img className={highlightMask ? 'dimmed-chart' : ''} src={openProject.thumbnailUrl} alt={openProject.name} />{highlightMask && <img className="highlight-chart" src={openProject.thumbnailUrl} alt="" style={{ WebkitMaskImage: `url(${highlightMask})`, maskImage: `url(${highlightMask})` }} />}</div></div>
      <footer className="viewer-controls"><div className="viewer-palette" aria-label="选择要高亮的色号"><span>{highlightMessage || (highlightCode ? `已选 ${highlightCode}` : '点色号高亮')}</span><div>{openProject.bead_project_items.slice().sort((a, b) => compareCodes(a.code, b.code)).map((item) => { const code = normalizeCode(item.code); return <button className={highlightCode === code ? 'active' : ''} type="button" key={code} onClick={() => void selectHighlight(code)}><i style={{ background: MARD_COLOR_BY_CODE.get(code)?.hex }}></i><b>{code}</b><small>{item.count}</small></button> })}</div></div><div className="viewer-toolbar"><button type="button" onClick={() => setViewerZoom((zoom) => Math.max(50, zoom - 25))}>−</button><button className="zoom-readout" type="button" onClick={() => setViewerZoom(100)}>{viewerZoom}%</button><button type="button" onClick={() => setViewerZoom((zoom) => Math.min(300, zoom + 25))}>＋</button><button className="fit-button" type="button" onClick={() => setViewerZoom(100)}>适应宽度</button></div></footer>
    </div>}
  </main>
}

export default App
