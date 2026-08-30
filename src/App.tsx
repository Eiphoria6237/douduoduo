import { useRef, useState } from 'react'
import './App.css'

function BeadMark() {
  return <div className="bead-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
}

function App() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')

  function handleFile(file?: File) {
    if (!file || !file.type.startsWith('image/')) return
    if (imageUrl) URL.revokeObjectURL(imageUrl)
    setImageUrl(URL.createObjectURL(file))
    setFileName(file.name)
  }

  return (
    <main className="app-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="豆多多首页"><BeadMark /><span>豆多多</span></a>
        <span className="local-badge"><b></b>仅在本机处理</span>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow">拼豆库存小助手</p>
        <h1>一张图纸，<br /><em>理清所有豆子。</em></h1>
        <p className="hero-copy">上传带用量清单的拼豆图纸，读取色号与颗数，做成你自己的库存账。</p>
      </section>

      <section className="workspace" aria-labelledby="upload-title">
        <div className="section-heading">
          <div><span className="step">01</span><h2 id="upload-title">放入一张图纸</h2></div>
          <p>JPG、PNG、截图均可</p>
        </div>

        {imageUrl ? (
          <div className="image-ready">
            <div className="image-frame"><img src={imageUrl} alt="已上传的拼豆图纸预览" /><span className="scan-line" aria-hidden="true"></span></div>
            <div className="image-summary">
              <div><span className="file-label">已选图纸</span><strong>{fileName}</strong></div>
              <button className="text-button" type="button" onClick={() => fileInput.current?.click()}>换一张</button>
            </div>
            <button className="primary-button" type="button">读取底部用量清单 <span>→</span></button>
            <p className="notice">下一步会先定位图纸下方的色号和颗数区域。</p>
          </div>
        ) : (
          <button className="drop-zone" type="button" onClick={() => fileInput.current?.click()}>
            <span className="upload-icon" aria-hidden="true">↑</span><strong>选择图纸图片</strong><span>从相册上传，或拖入这里</span><small>不上传服务器，图片留在你的设备上</small>
          </button>
        )}
        <input ref={fileInput} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handleFile(event.target.files?.[0])} />
      </section>

      <section className="how-it-works" aria-labelledby="how-title">
        <div className="section-heading compact"><div><span className="step">小而准确</span><h2 id="how-title">只读你真正需要的部分</h2></div></div>
        <div className="process-grid">
          <article><span className="process-number">1</span><h3>找到用量清单</h3><p>优先读取图纸底部已有的色号统计，不逐格猜颜色。</p></article>
          <article><span className="process-number">2</span><h3>确认每一项</h3><p>支持 <code>A01 52颗</code>、<code>A01（52）</code> 等常见格式。</p></article>
          <article><span className="process-number">3</span><h3>更新库存</h3><p>识别结果由你确认后，才会写入你的库存记录。</p></article>
        </div>
      </section>

      <section className="promise">
        <div className="promise-orb" aria-hidden="true"><span></span><span></span><span></span></div>
        <div><p className="eyebrow">为自己的豆仓而做</p><h2>不做图纸社区，<br />只把库存算明白。</h2></div>
      </section>
    </main>
  )
}

export default App
