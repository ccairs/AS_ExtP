# es3-parser (vendored acorn)

AST 编译门使用的 ES3 解析器，取自 [acorn](https://github.com/acornjs/acorn) 官方发行版。

## 溯源

- **上游**：acorn（MIT License）
- **版本**：8.18.0（npm registry dist 原样落位：`dist/acorn.js`；TypeScript 型别声明 `acorn.d.ts` 不随公开树分发）
- **裁剪**：零裁剪（官方完整 UMD dist，CEP 面板与 Node 双端可用）
- **使用方式**：统一以 `ecmaVersion: 3` 调用 `parse()`——ES6 语法（let / const / 箭头函数 / 模板串等）直接报错
