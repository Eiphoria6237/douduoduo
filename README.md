# 豆多多

## OpenAI 清单识别

裁切后的清单由浏览器直接提交给 Supabase Edge Function，再由函数调用 OpenAI Responses API。图片不会写入 Supabase Storage；只有用户保存图纸时，现有逻辑才会上传完整原图的压缩缩略图。

识别接口要求用户已登录。部署前配置服务端密钥并发布函数：

```bash
supabase secrets set OPENAI_API_KEY=你的_OpenAI_API_Key
supabase secrets set OPENAI_MODEL=gpt-5.4
supabase functions deploy recognize-legend
```

`OPENAI_MODEL` 可省略，默认使用 `gpt-5.4`。OpenAI API 费用与 ChatGPT Plus 分开结算。不要把 `OPENAI_API_KEY` 放进 `.env`、前端代码或 Supabase 数据表。

## 本地开发

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
