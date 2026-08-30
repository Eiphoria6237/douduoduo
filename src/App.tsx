import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { createWorker, PSM } from 'tesseract.js'
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
type OcrWord = { text: string; x: number; y: number }
type LegendSwatch = OcrWord & { x0: number; y0: number; x1: number; y1: number }

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
  const scale = Math.min(4, 2600 / bounds.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bounds.width * scale)
  canvas.height = Math.round(cropHeight * scale)
  const context = canvas.getContext('2d')!
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, bounds.x, y, bounds.width, cropHeight, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

function rgbDistance(first: [number, number, number], second: [number, number, number]) {
  return (first[0] - second[0]) ** 2 + (first[1] - second[1]) ** 2 + (first[2] - second[2]) ** 2
}

const MARD_RGB = MARD_COLORS.map((color) => ({
  code: color.code,
  rgb: [Number.parseInt(color.hex.slice(1, 3), 16), Number.parseInt(color.hex.slice(3, 5), 16), Number.parseInt(color.hex.slice(5, 7), 16)] as [number, number, number],
}))

async function detectLegendSwatches(url: string): Promise<LegendSwatch[]> {
  const image = await loadImage(url)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(image, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  const step = Math.max(2, Math.ceil(canvas.width / 1000))
  const width = Math.ceil(canvas.width / step)
  const height = Math.ceil(canvas.height / step)
  const mask = new Uint8Array(width * height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = ((Math.min(canvas.height - 1, y * step) * canvas.width) + Math.min(canvas.width - 1, x * step)) * 4
      const red = pixels[source]
      const green = pixels[source + 1]
      const blue = pixels[source + 2]
      const brightness = (red + green + blue) / 3
      if (brightness < 244 || Math.max(red, green, blue) - Math.min(red, green, blue) > 10) mask[y * width + x] = 1
    }
  }

  const visited = new Uint8Array(mask.length)
  const components: Array<{ x0: number; y0: number; x1: number; y1: number; area: number }> = []
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue
    const queue = [start]
    visited[start] = 1
    let cursor = 0
    let x0 = width
    let y0 = height
    let x1 = 0
    let y1 = 0
    while (cursor < queue.length) {
      const point = queue[cursor++]
      const x = point % width
      const y = Math.floor(point / width)
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
      const neighbors = [point - 1, point + 1, point - width, point + width]
      neighbors.forEach((next) => {
        if (next < 0 || next >= mask.length || visited[next] || !mask[next]) return
        const nextX = next % width
        if (Math.abs(nextX - x) > 1) return
        visited[next] = 1
        queue.push(next)
      })
    }
    const componentWidth = x1 - x0 + 1
    const componentHeight = y1 - y0 + 1
    const coverage = queue.length / (componentWidth * componentHeight)
    if (componentWidth >= width * 0.018 && componentWidth <= width * 0.16 && componentHeight >= 8 && componentHeight <= height * 0.8 && componentWidth / componentHeight >= 0.45 && componentWidth / componentHeight <= 2.3 && coverage >= 0.04) components.push({ x0, y0, x1, y1, area: queue.length })
  }

  const rows: typeof components[] = []
  components.sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1)).forEach((component) => {
    const center = (component.y0 + component.y1) / 2
    const row = rows.find((candidate) => Math.abs((candidate.reduce((sum, item) => sum + item.y0 + item.y1, 0) / candidate.length / 2) - center) < Math.max(6, height * 0.08))
    if (row) row.push(component)
    else rows.push([component])
  })
  const candidateRows = rows.filter((row) => row.length >= 2 && row.length <= 40).map((row) => {
    const widths = row.map((item) => item.x1 - item.x0 + 1).sort((a, b) => a - b)
    const heights = row.map((item) => item.y1 - item.y0 + 1).sort((a, b) => a - b)
    const medianWidth = widths[Math.floor(widths.length / 2)]
    const medianHeight = heights[Math.floor(heights.length / 2)]
    return row.filter((item) => {
      const itemWidth = item.x1 - item.x0 + 1
      const itemHeight = item.y1 - item.y0 + 1
      return itemWidth >= medianWidth * 0.55 && itemWidth <= medianWidth * 1.75 && itemHeight >= medianHeight * 0.55 && itemHeight <= medianHeight * 1.75
    })
  }).filter((row) => row.length >= 2)
  const largestAverageArea = Math.max(0, ...candidateRows.map((row) => row.reduce((sum, item) => sum + item.area, 0) / row.length))
  const swatchRow = candidateRows
    .filter((row) => row.reduce((sum, item) => sum + item.area, 0) / row.length >= largestAverageArea * 0.2)
    .sort((a, b) => Math.max(...b.map((item) => item.y1)) - Math.max(...a.map((item) => item.y1)))[0]
  if (!swatchRow) return []

  return swatchRow.sort((a, b) => a.x0 - b.x0).map((component) => {
    const samples: Array<[number, number, number]> = []
    const left = Math.round((component.x0 * 0.7 + component.x1 * 0.3) * step)
    const right = Math.round((component.x0 * 0.3 + component.x1 * 0.7) * step)
    const top = Math.round((component.y0 * 0.7 + component.y1 * 0.3) * step)
    const bottom = Math.round((component.y0 * 0.3 + component.y1 * 0.7) * step)
    for (let y = top; y <= bottom; y += Math.max(1, step)) for (let x = left; x <= right; x += Math.max(1, step)) {
      const index = (Math.min(canvas.height - 1, y) * canvas.width + Math.min(canvas.width - 1, x)) * 4
      samples.push([pixels[index], pixels[index + 1], pixels[index + 2]])
    }
    const median = [0, 1, 2].map((channel) => samples.map((sample) => sample[channel]).sort((a, b) => a - b)[Math.floor(samples.length / 2)]) as [number, number, number]
    const color = MARD_RGB.reduce((best, candidate) => rgbDistance(candidate.rgb, median) < rgbDistance(best.rgb, median) ? candidate : best)
    return {
      text: color.code,
      x: ((component.x0 + component.x1) / 2) * step,
      y: ((component.y0 + component.y1) / 2) * step,
      x0: component.x0 * step,
      y0: component.y0 * step,
      x1: Math.min(canvas.width, (component.x1 + 1) * step),
      y1: Math.min(canvas.height, (component.y1 + 1) * step),
    }
  })
}

function makeOcrTile(image: HTMLImageElement, rectangle: { left: number; top: number; width: number; height: number }, mode: 'swatch' | 'number') {
  const source = document.createElement('canvas')
  source.width = Math.max(1, Math.round(rectangle.width))
  source.height = Math.max(1, Math.round(rectangle.height))
  const sourceContext = source.getContext('2d', { willReadFrequently: true })!
  sourceContext.drawImage(image, rectangle.left, rectangle.top, rectangle.width, rectangle.height, 0, 0, source.width, source.height)
  const imageData = sourceContext.getImageData(0, 0, source.width, source.height)
  const pixels = imageData.data
  const medians = [0, 1, 2].map((channel) => {
    const values: number[] = []
    for (let index = channel; index < pixels.length; index += 4) values.push(pixels[index])
    values.sort((a, b) => a - b)
    return values[Math.floor(values.length / 2)]
  })
  for (let index = 0; index < pixels.length; index += 4) {
    const isInk = mode === 'swatch'
      ? Math.sqrt((pixels[index] - medians[0]) ** 2 + (pixels[index + 1] - medians[1]) ** 2 + (pixels[index + 2] - medians[2]) ** 2) > 42
      : (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3 < 170
    pixels[index] = isInk ? 0 : 255
    pixels[index + 1] = isInk ? 0 : 255
    pixels[index + 2] = isInk ? 0 : 255
    pixels[index + 3] = 255
  }
  sourceContext.putImageData(imageData, 0, 0)

  const scale = Math.max(4, Math.ceil(260 / source.width))
  const tile = document.createElement('canvas')
  tile.width = source.width * scale + 80
  tile.height = source.height * scale + 80
  const tileContext = tile.getContext('2d')!
  tileContext.fillStyle = '#fff'
  tileContext.fillRect(0, 0, tile.width, tile.height)
  tileContext.imageSmoothingEnabled = false
  tileContext.drawImage(source, 0, 0, source.width, source.height, 40, 40, source.width * scale, source.height * scale)
  return tile.toDataURL('image/png')
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

function recognizedMardCode(value: string) {
  const code = normalizeCode(value.replace(/[^A-Z0-9]/gi, ''))
  return MARD_COLOR_BY_CODE.has(code) ? code : ''
}

function inventoryLines(pairs: Array<[string, string]>) {
  const merged = new Map<string, number>()
  pairs.forEach(([code, count]) => {
    const quantity = Number(count)
    if (code && Number.isInteger(quantity) && quantity >= 0) merged.set(code, (merged.get(code) ?? 0) + quantity)
  })
  return [...merged].map(([code, count]) => ({ id: crypto.randomUUID(), code, count: String(count) }))
}

function assistedLines(codes: OcrWord[], counts: OcrWord[]) {
  const sortedCounts = [...counts].sort((a, b) => a.x - b.x)
  return [...codes].sort((a, b) => a.x - b.x).map((code, index) => ({
    id: crypto.randomUUID(),
    code: code.text,
    count: sortedCounts.length === codes.length ? sortedCounts[index].text : '',
  }))
}

function extractOcrWords(blocks: Array<{ paragraphs: Array<{ lines: Array<{ words: Array<{ text: string; bbox: { x0: number; y0: number; x1: number } }> }> }> }> | null): OcrWord[] {
  return blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words.map((word) => ({ text: word.text, x: (word.bbox.x0 + word.bbox.x1) / 2, y: word.bbox.y0 }))))) ?? []
}

function groupWordsByRow<T extends { y: number }>(words: T[]) {
  const rows: T[][] = []
  words.sort((a, b) => a.y - b.y).forEach((word) => {
    const row = rows.find((candidate) => Math.abs(candidate.reduce((sum, item) => sum + item.y, 0) / candidate.length - word.y) < 24)
    if (row) row.push(word)
    else rows.push([word])
  })
  return rows
}

function parseOcrText(text: string, words: OcrWord[] = []) {
  const codeRows = groupWordsByRow(words.map((word) => ({ ...word, code: recognizedMardCode(word.text) })).filter((word) => word.code))
  const positionedCodes = (codeRows.filter((row) => row.length > 1).sort((a, b) => Math.max(...b.map((word) => word.y)) - Math.max(...a.map((word) => word.y)))[0] ?? []).sort((a, b) => a.x - b.x).filter((word, index, all) => !all.slice(0, index).some((candidate) => Math.abs(candidate.x - word.x) < 40))
  if (positionedCodes.length > 1) {
    const codeY = Math.max(...positionedCodes.map((code) => code.y))
    const countRows = groupWordsByRow(words.filter((word) => /^\d{1,4}$/.test(word.text.trim()) && word.y > codeY + 8))
    const counts = (countRows.sort((a, b) => Math.abs(a.length - positionedCodes.length) - Math.abs(b.length - positionedCodes.length) || Math.min(...a.map((word) => word.y)) - Math.min(...b.map((word) => word.y)))[0] ?? []).sort((a, b) => a.x - b.x)
    if (positionedCodes.length === counts.length) return inventoryLines(positionedCodes.map((code, index) => [code.code, counts[index].text]))
  }

  const pieces = text.toUpperCase().replace(/[|]/g, ' ').match(/[A-Z]{1,2}\s*\d{1,2}|(?<![A-Z0-9])\d{1,4}(?![A-Z0-9])/g) ?? []
  const codes = pieces.map(recognizedMardCode).filter(Boolean)
  const counts = pieces.filter((piece) => /^\d{1,4}$/.test(piece))
  if (codes.length > 1 && codes.length === counts.length) return inventoryLines(codes.map((code, index) => [code, counts[index]]))

  const pairs: Array<[string, string]> = []
  let code = ''
  for (const piece of pieces) {
    const recognized = recognizedMardCode(piece)
    if (recognized) code = recognized
    else if (code && /^\d{1,4}$/.test(piece)) {
      pairs.push([code, piece])
      code = ''
    }
  }
  return inventoryLines(pairs)
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
      await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789()[] ', tessedit_pageseg_mode: PSM.SPARSE_TEXT, preserve_interword_spaces: '1' })
      const [result, swatches, cropImageElement] = await Promise.all([
        worker.recognize(cropUrl, {}, { text: true, blocks: true }),
        detectLegendSwatches(cropUrl),
        loadImage(cropUrl),
      ])
      let swatchCodes: OcrWord[] = swatches
      let quantityWords: OcrWord[] = []
      const detailText: string[] = []
      if (swatches.length > 1) {
        await worker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', tessedit_pageseg_mode: PSM.SINGLE_WORD })
        swatchCodes = []
        for (const swatch of swatches) {
          const insetX = Math.max(1, Math.round((swatch.x1 - swatch.x0) * 0.12))
          const insetY = Math.max(1, Math.round((swatch.y1 - swatch.y0) * 0.12))
          const codeTile = makeOcrTile(cropImageElement, { left: swatch.x0 + insetX, top: swatch.y0 + insetY, width: swatch.x1 - swatch.x0 - insetX * 2, height: swatch.y1 - swatch.y0 - insetY * 2 }, 'swatch')
          const codeResult = await worker.recognize(codeTile, {}, { text: true })
          const code = recognizedMardCode(codeResult.data.text) || swatch.text
          swatchCodes.push({ text: code, x: swatch.x, y: swatch.y })
          detailText.push(`${codeResult.data.text.trim() || '?'}>${code}`)
        }

        await worker.setParameters({ tessedit_char_whitelist: '0123456789 ', tessedit_pageseg_mode: PSM.SINGLE_LINE, preserve_interword_spaces: '1' })
        const quantityTop = Math.round(cropImageElement.naturalHeight * 0.5)
        const quantityResult = await worker.recognize(cropUrl, { rectangle: { left: 0, top: quantityTop, width: cropImageElement.naturalWidth, height: cropImageElement.naturalHeight - quantityTop } }, { text: true, blocks: true })
        const candidates = [
          ...extractOcrWords(quantityResult.data.blocks),
          ...extractOcrWords(result.data.blocks).filter((word) => word.y >= quantityTop),
        ].filter((word) => /^\d{1,4}$/.test(word.text.trim()))
        quantityWords = swatches.flatMap((swatch) => {
          const nearby = candidates.filter((candidate) => swatches.reduce((closest, other) => Math.abs(candidate.x - other.x) < Math.abs(candidate.x - closest.x) ? other : closest) === swatch)
          const best = nearby.sort((a, b) => b.text.trim().length - a.text.trim().length)[0]
          return best ? [{ text: best.text.trim(), x: swatch.x, y: quantityTop + 30 }] : []
        })
        detailText.push(`数量:${quantityResult.data.text.trim() || '?'}`)
      }
      await worker.terminate()
      const parsed = parseOcrText(result.data.text, extractOcrWords(result.data.blocks))
      const recognized = swatchCodes.length > 1 ? assistedLines(swatchCodes, quantityWords) : parsed
      setOcrText(`${result.data.text}\n逐项识别：${detailText.join(' / ') || '无'}\n色块检测：${swatches.map((swatch) => swatch.text).join('、') || '无'}`)
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
        {!imageUrl ? <button className="drop-zone" type="button" onClick={() => fileInput.current?.click()}><span className="upload-icon" aria-hidden="true">↑</span><strong>选择图纸图片</strong><span>从相册上传，或拖入这里</span><small>识别在本机完成；保存时同步压缩缩略图</small></button> : <div className="scanner">
          <div className="image-summary"><div><span className="file-label">已选图纸</span><strong>{fileName}</strong></div><button className="text-button" type="button" onClick={() => fileInput.current?.click()}>换一张</button></div>
          <div className="crop-preview">{cropUrl && <img src={cropUrl} alt="将被识别的用量清单区域" />}</div>
          <div className="crop-controls"><div><label htmlFor="top">清单从原图的哪里开始</label><output>{cropTop}%</output></div><input id="top" type="range" min="0" max="95" value={cropTop} onChange={(event) => { const next = Number(event.target.value); setCropTop(next); setCropHeight((current) => Math.min(current, 100 - next)) }} /><div><label htmlFor="height">清单区域高度</label><output>{cropHeight}%</output></div><input id="height" type="range" min="5" max={100 - cropTop} value={cropHeight} onChange={(event) => setCropHeight(Number(event.target.value))} /></div>
          <div style={{ display: 'flex', gap: 14, margin: '0 2px 14px' }}><button className="text-button" type="button" onClick={() => { setCropTop(88); setCropHeight(12) }}>只看底部图例</button><button className="text-button" type="button" onClick={() => { setCropTop(DEFAULT_CROP_TOP); setCropHeight(DEFAULT_CROP_HEIGHT) }}>底部宽范围</button></div>
          <button className="primary-button" type="button" onClick={recognize} disabled={!cropUrl || progress.includes('正在')}><span>{progress.includes('正在') ? progress : '读取这块清单'}</span><b>→</b></button>
        </div>}
        <input ref={fileInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handleFile(event.target.files?.[0])} />
      </section>
      {imageUrl && <section className="review" aria-labelledby="review-title"><div className="section-heading compact"><div><span className="step">02</span><h2 id="review-title">确认盘点结果</h2></div><p>{progress || '调好区域后开始识别'}</p></div>{rows.length > 0 && <><label className="project-name">图纸名称<input value={projectName} onChange={(event) => setProjectName(event.target.value)} /></label><div className="table-head"><span>标准色号</span><span>颗数</span><span></span></div><div className="inventory-table">{rows.map((row) => <div className="inventory-row" key={row.id}><input aria-label="色号" value={row.code} placeholder="例如 C20" onChange={(event) => updateRow(row.id, 'code', event.target.value)} /><input aria-label="颗数" inputMode="numeric" value={row.count} placeholder="数量" onChange={(event) => updateRow(row.id, 'count', event.target.value)} /><button type="button" aria-label={`删除 ${row.code || '该项'}`} onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}>×</button></div>)}</div><button type="button" className="add-row" onClick={() => setRows((current) => [...current, newLine()])}>+ 补一项</button><div className="total-check"><label>图纸总计（选填） <input inputMode="numeric" value={total} placeholder="可不填" onChange={(event) => setTotal(event.target.value.replace(/\D/g, ''))} /> 颗</label><strong>已录入 {sum} 颗</strong>{total && delta !== 0 && <p>相差 <b>{Math.abs(delta)}</b> 颗：可能有一项被水印遮住。</p>}{total && delta === 0 && <p className="good">总计一致，可以保存。</p>}</div>{session ? <div className="save-panel"><button className="primary-button" type="button" onClick={saveProject}>保存为“打算拼” <b>→</b></button>{saveMessage && <p>{saveMessage}</p>}</div> : <p className="save-hint">登录后才能保存到“我的图纸”。</p>}</>}{ocrText && <details><summary>查看原始 OCR 文本</summary><pre>{ocrText}</pre></details>}</section>}
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
