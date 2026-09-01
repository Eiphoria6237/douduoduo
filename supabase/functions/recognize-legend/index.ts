const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

function outputText(response: Record<string, unknown>) {
  const output = Array.isArray(response.output) ? response.output : []
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : []
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'output_text' && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text
      }
    }
  }
  return ''
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const openaiApiKey = Deno.env.get('OPENAI_API_KEY')
  const authorization = request.headers.get('Authorization')
  if (!supabaseUrl || !supabaseAnonKey || !openaiApiKey) return json({ error: '服务端配置不完整' }, 500)
  if (!authorization) return json({ error: '请先登录' }, 401)

  const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: supabaseAnonKey },
  })
  if (!userResponse.ok) return json({ error: '登录已失效，请重新登录' }, 401)

  let imageDataUrl = ''
  try {
    const body = await request.json()
    imageDataUrl = typeof body?.imageDataUrl === 'string' ? body.imageDataUrl : ''
  } catch {
    return json({ error: '请求格式不正确' }, 400)
  }

  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)) {
    return json({ error: '只支持 PNG、JPEG 或 WebP 图片' }, 400)
  }
  if (imageDataUrl.length > 11_000_000) return json({ error: '裁切图片不能超过 8 MB' }, 413)

  const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: Deno.env.get('OPENAI_MODEL') ?? 'gpt-5.4',
      store: false,
      max_output_tokens: 1800,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              '这是一张只包含 Mard 拼豆图纸用量清单的裁切图片。',
              '逐行从左到右、从上到下读取所有色号和括号内数量，不要遗漏左右边缘项目。',
              '只抄录图片中清晰可见的项目，不要根据颜色猜测或补全。',
              '合法色号范围：A1-A26、B1-B32、C1-C29、D1-D26、E1-E24、F1-F25、G1-G21、H1-H23、M1-M15。',
              '每个色号只返回一次，count 必须是图片中对应的非负整数。',
            ].join('\n'),
          },
          { type: 'input_image', image_url: imageDataUrl, detail: 'original' },
        ],
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'mard_legend',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    code: { type: 'string' },
                    count: { type: 'integer', minimum: 0 },
                  },
                  required: ['code', 'count'],
                  additionalProperties: false,
                },
              },
            },
            required: ['items'],
            additionalProperties: false,
          },
        },
      },
    }),
  })

  const openaiResult = await openaiResponse.json()
  if (!openaiResponse.ok) {
    const message = openaiResult?.error?.message
    console.error('OpenAI request failed', openaiResponse.status, message)
    return json({ error: typeof message === 'string' ? message : 'OpenAI 请求失败' }, 502)
  }

  try {
    const parsed = JSON.parse(outputText(openaiResult))
    return json({ items: parsed.items, usage: openaiResult.usage })
  } catch {
    console.error('OpenAI returned no parseable output', openaiResult?.status)
    return json({ error: 'OpenAI 未返回可解析的清单' }, 502)
  }
})
