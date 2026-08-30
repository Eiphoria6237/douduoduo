import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { createWorker } from 'tesseract.js'
import { supabase } from './lib/supabase'
import './App.css'

type Bounds = { x: number; y: number; width: number; height: number }
type InventoryLine = { id: string; code: string; count: string }
type SavedProject = { id: string; name: string; total: number | null; created_at: string }
const newLine = (): InventoryLine => ({ id: crypto.randomUUID(), code: '', count: '' })

function BeadMark() { return <div className="bead-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div> }

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url })
}

function findSheetBounds(image: HTMLImageElement): Bounds {
  const width = Math.min(image.naturalWidth, 640)
  const height = Math.round(image.naturalHeight * (width / image.naturalWidth))
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(image, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height).data
  const brightRows: number[] = []
  for (let y = 0; y < height; y += 2) {
    let bright = 0
    for (let x = 0; x < width; x += 3) { const i = (y * width + x) * 4; if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 130) bright += 1 }
    if (bright / Math.ceil(width / 3) > 0.62) brightRows.push(y)
  }
  let start = 0; let end = height; let longest = 0; let runStart = 0; let previous = -4
  for (const row of brightRows) { if (row - previous > 3) runStart = row; if (row - runStart > longest) { start = runStart; end = row; longest = row - runStart }; previous = row }
  if (longest < height * 0.2) return { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight }
  const scale = image.naturalWidth / width
  const top = Math.max(0, start - 4) * scale
  return { x: 0, y: top, width: image.naturalWidth, height: Math.min(height, end + 5) * scale - top }
}

function cropImage(image: HTMLImageElement, bounds: Bounds, top: number, height: number) {
  const y = bounds.y + bounds.height * top / 100
  const cropHeight = bounds.height * height / 100
  const scale = Math.min(3, 1800 / bounds.width)
  const canvas = document.createElement('canvas'); canvas.width = Math.round(bounds.width * scale); canvas.height = Math.round(cropHeight * scale)
  const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, bounds.x, y, bounds.width, cropHeight, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

function parseOcrText(text: string) {
  const pieces = text.toUpperCase().replace(/[|]/g, ' ').match(/[A-Z]{1,2}\s*\d{1,2}|(?<![A-Z0-9])\d{1,4}(?![A-Z0-9])/g) ?? []
  const lines: InventoryLine[] = []; let code = ''
  for (const piece of pieces) { const compact = piece.replace(/\s/g, ''); if (/^[A-Z]{1,2}\d{1,2}$/.test(compact)) code = compact; else if (code && /^\d{1,4}$/.test(compact)) { lines.push({ id: crypto.randomUUID(), code, count: compact }); code = '' } }
  return lines.filter((line, index, all) => all.findIndex((candidate) => candidate.code === line.code) === index)
}

function App() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [bounds, setBounds] = useState<Bounds | null>(null)
  const [cropTop, setCropTop] = useState(80)
  const [cropHeight, setCropHeight] = useState(20)
  const [cropUrl, setCropUrl] = useState<string | null>(null)
  const [progress, setProgress] = useState('')
  const [rows, setRows] = useState<InventoryLine[]>([])
  const [total, setTotal] = useState('')
  const [ocrText, setOcrText] = useState('')
  const [projectName, setProjectName] = useState('未命名图纸')
  const [session, setSession] = useState<Session | null>(null)
  const [email, setEmail] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [saveMessage, setSaveMessage] = useState('')
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([])

  async function loadProjects() {
    if (!supabase) return
    const { data } = await supabase.from('bead_projects').select('id,name,total,created_at').order('created_at', { ascending: false }).limit(8)
    setSavedProjects(data ?? [])
  }

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => { if (session) void loadProjects() }, [session])

  useEffect(() => { if (imageUrl && bounds) void loadImage(imageUrl).then((image) => setCropUrl(cropImage(image, bounds, cropTop, cropHeight))) }, [bounds, cropHeight, cropTop, imageUrl])

  function handleFile(file?: File) {
    if (!file || !file.type.startsWith('image/')) return
    if (imageUrl) URL.revokeObjectURL(imageUrl)
    const url = URL.createObjectURL(file); setImageUrl(url); setFileName(file.name); setProjectName(file.name.replace(/\.[^.]+$/, '')); setRows([]); setTotal(''); setOcrText(''); setProgress(''); setSaveMessage('')
    void loadImage(url).then((image) => setBounds(findSheetBounds(image)))
  }

  async function recognize() {
    if (!cropUrl) return
    setProgress('正在加载本地识别器…')
    try {
      const worker = await createWorker('eng', 1, { logger: (message) => { if (message.status === 'recognizing text') setProgress(`正在读取清单… ${Math.round(message.progress * 100)}%`) } })
      await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()[] ' })
      const { data } = await worker.recognize(cropUrl); await worker.terminate()
      const recognized = parseOcrText(data.text); setOcrText(data.text); setRows(recognized.length ? recognized : [newLine()]); setProgress(recognized.length ? `已读出 ${recognized.length} 种颜色，请逐项确认。` : '没有可靠读出结果，请在下方手动补录。')
    } catch { setProgress('识别器未能启动，请检查网络后重试。') }
  }

  const sum = rows.reduce((value, row) => value + (Number(row.count) || 0), 0)
  const delta = total ? Number(total) - sum : 0
  const updateRow = (id: string, key: 'code' | 'count', value: string) => setRows((current) => current.map((row) => row.id === id ? { ...row, [key]: key === 'code' ? value.toUpperCase() : value.replace(/\D/g, '') } : row))

  async function sendMagicLink() {
    if (!supabase || !email) return
    setAuthMessage('正在发送登录链接…')
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } })
    setAuthMessage(error ? `发送失败：${error.message}` : '登录链接已发送，请在邮箱中打开。')
  }

  async function saveProject() {
    if (!supabase || !session) return
    const items = rows.filter((row) => row.code && row.count !== '' && Number.isFinite(Number(row.count))).map((row) => ({ code: row.code, count: Number(row.count) }))
    if (!items.length) { setSaveMessage('至少补录一项色号和数量后才能保存。'); return }
    setSaveMessage('正在保存…')
    const { data: project, error } = await supabase.from('bead_projects').insert({ user_id: session.user.id, name: projectName.trim() || '未命名图纸', total: total ? Number(total) : null }).select('id').single()
    if (error || !project) { setSaveMessage(`保存失败：${error?.message ?? '未知错误'}`); return }
    const { error: itemsError } = await supabase.from('bead_project_items').insert(items.map((item) => ({ ...item, project_id: project.id })))
    if (itemsError) { setSaveMessage(`明细保存失败：${itemsError.message}`); return }
    setSaveMessage('已保存到你的云端库存记录。')
    void loadProjects()
  }

  return <main className="app-shell">
    <header className="site-header"><a className="brand" href="#top" aria-label="豆多多首页"><BeadMark /><span>豆多多</span></a><span className="local-badge"><b></b>图片仅在本机处理</span></header>
    <section className="hero" id="top"><p className="eyebrow">拼豆库存小助手</p><h1>一张图纸，<br /><em>理清所有豆子。</em></h1><p className="hero-copy">先读取图纸底部的用量清单，再由你确认一遍。水印或截图遮挡的少数项目，留给人工补齐。</p></section>
    <section className="workspace" aria-labelledby="upload-title"><div className="section-heading"><div><span className="step">01</span><h2 id="upload-title">放入一张图纸</h2></div><p>JPG、PNG、截图均可</p></div>
      {!imageUrl ? <button className="drop-zone" type="button" onClick={() => fileInput.current?.click()}><span className="upload-icon" aria-hidden="true">↑</span><strong>选择图纸图片</strong><span>从相册上传，或拖入这里</span><small>不上传服务器，图片留在你的设备上</small></button> : <div className="scanner"><div className="image-summary"><div><span className="file-label">已选图纸</span><strong>{fileName}</strong></div><button className="text-button" type="button" onClick={() => fileInput.current?.click()}>换一张</button></div><div className="crop-preview">{cropUrl && <img src={cropUrl} alt="将被识别的用量清单区域" />}</div><div className="crop-controls"><div><label htmlFor="top">清单从图纸的哪里开始</label><output>{cropTop}%</output></div><input id="top" type="range" min="60" max="94" value={cropTop} onChange={(event) => { const next = Number(event.target.value); setCropTop(next); setCropHeight((current) => Math.min(current, 100 - next)) }} /><div><label htmlFor="height">清单区域高度</label><output>{cropHeight}%</output></div><input id="height" type="range" min="5" max={100 - cropTop} value={cropHeight} onChange={(event) => setCropHeight(Number(event.target.value))} /></div><button className="primary-button" type="button" onClick={recognize} disabled={!cropUrl || progress.includes('正在')}><span>{progress.includes('正在') ? progress : '读取这块清单'}</span><b>→</b></button></div>}
      <input ref={fileInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handleFile(event.target.files?.[0])} /></section>
    {imageUrl && <section className="review" aria-labelledby="review-title"><div className="section-heading compact"><div><span className="step">02</span><h2 id="review-title">确认盘点结果</h2></div><p>{progress || '调好区域后开始识别'}</p></div>{rows.length > 0 && <><label className="project-name">图纸名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><div className="table-head"><span>标准色号</span><span>颗数</span><span></span></div><div className="inventory-table">{rows.map((row) => <div className="inventory-row" key={row.id}><input aria-label="色号" value={row.code} placeholder="例如 C20" onChange={(event) => updateRow(row.id, 'code', event.target.value)} /><input aria-label="颗数" inputMode="numeric" value={row.count} placeholder="数量" onChange={(event) => updateRow(row.id, 'count', event.target.value)} /><button type="button" aria-label={`删除 ${row.code || '该项'}`} onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}>×</button></div>)}</div><button type="button" className="add-row" onClick={() => setRows((current) => [...current, newLine()])}>+ 补一项</button><div className="total-check"><label>图纸总计 <input inputMode="numeric" value={total} placeholder="例如 192" onChange={(event) => setTotal(event.target.value.replace(/\D/g, ''))} /> 颗</label><strong>已录入 {sum} 颗</strong>{total && delta !== 0 && <p>还差 <b>{Math.abs(delta)}</b> 颗：可能有一项被水印遮住，请检查后补录。</p>}{total && delta === 0 && <p className="good">总计一致，可以放心保存。</p>}</div>{session ? <div className="save-panel"><button className="primary-button" type="button" onClick={saveProject}>保存这张图纸到云端 <b>→</b></button>{saveMessage && <p>{saveMessage}</p>}</div> : <p className="save-hint">配置 Supabase 并登录后，可以把确认结果保存到云端。</p>}</>}{ocrText && <details><summary>查看原始 OCR 文本</summary><pre>{ocrText}</pre></details>}</section>}
    <section className="cloud-panel" aria-labelledby="cloud-title"><div><span className="step">03</span><h2 id="cloud-title">云端库存</h2></div>{!supabase ? <p>等待连接 Supabase。填好 `.env.local` 后即可启用登录和保存。</p> : session ? <><div className="cloud-account"><span>{session.user.email}</span><button className="text-button" type="button" onClick={() => void supabase?.auth.signOut()}>退出</button></div><p>图纸图片不保存，仅保存你确认过的色号与数量。</p>{savedProjects.length > 0 && <ul className="saved-list">{savedProjects.map((project) => <li key={project.id}><strong>{project.name}</strong><span>{project.total ?? '未填总数'} 颗</span></li>)}</ul>}</> : <><p>用邮箱登录，保存自己的图纸用量记录。首次登录会收到一封链接邮件。</p><div className="auth-form"><input type="email" value={email} placeholder="你的邮箱" onChange={(event) => setEmail(event.target.value)} /><button type="button" onClick={sendMagicLink}>发送登录链接</button></div>{authMessage && <small>{authMessage}</small>}</>}</section>
    <section className="promise"><div className="promise-orb" aria-hidden="true"><span></span><span></span><span></span></div><div><p className="eyebrow">半自动，而非盲自动</p><h2>机器先读一遍，<br />你来做最后确认。</h2></div></section>
  </main>
}

export default App
