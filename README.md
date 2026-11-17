# review-production

审阅资料交付中页码范围与文档家族接收相关资料接收服务，面向授权来源的原件领取、解释和持久查询。

## 当前能力

既能解析单个 DAT/OPT load file，也能**按一次 production 交付整体接收**：以交付清单（manifest）为入口领取 DAT、OPT 与各卷声明的图像、原生和文本资源，核对文档家族、页码范围、图像页与原生/文本声明，把收件问题逐条登记在案。证据身份（Bates 标识）与本次交付身份（production id、intake id）分别保留；受限交付与脱敏公开交付的链接互不授予可见性。

`src/reader.mjs` 提供 DAT/OPT 读取契约；`src/production.mjs` 负责 production 级核对与问题登记；`src/transport.mjs` 只访问配置来源的同源地址，拒绝隐式跳转；`src/store.mjs` 保存原件摘要、解释结果与 production 收件记录。`src/service.mjs` 是产品入口，`src/provider.mjs` 是独立 HTTP 联调来源，内容为无个人信息的本地样例。

### 核对规则（不做的推测与不建的链接）

- 页码只认 OPT 明列的 page-id：DAT 的 BEGDOC/ENDDOC 与 OPT 文档分组逐页比对，缺页、`page_duplicate_attribution`（同一页码重复归属）、范围不符、声明页数不符、卷不一致都登记为具体收件问题；绝不按 Bates 数字连续性补出不存在的页面。
- 家族按 DAT 的 BEGATTACH/ENDATTACH 归组，区分主件（parent）与附件（attachment），记录成员与跨卷卷号；成员缺页、范围不符、卷未声明或资源不可达时家族 `complete=false`，并在问题上挂 `familyId` 便于定位。
- 资源路径只按本 production 清单的 `volumes` 映射解析，拒绝跨目录/跨源路径；DAT 中 NATIVE/TEXT 为空表示未声明，不领取也不链接。
- 公开（脱敏）交付只建立清单显式声明的资源链接；`native: null` 即永久无原件链接——即使受限交付中存在相同内容摘要的字节，也绝不自动复用链接。共享 evidence id 或内容摘要不授予可见性。
- 每次接收独立留痕：不同时间点来源状态可能不同（如图像临时 404），各自的收件问题必须各自准确登记。

## 环境与运行

Node.js 22.22 至 22.x，无 npm 依赖，无外部运行服务或下载步骤。Linux、Windows 均使用以下命令；干净目录可直接运行。

```sh
npm ci --offline --ignore-scripts
npm test
npm run build
npm run demo
```

`npm run demo` 自动在本机回环端口启动来源与产品、领取一件资料、读取已保存结果，然后关闭服务并清理临时目录。它展示当前产品能力，不模拟尚不存在的能力。演示没有固定等待、外网访问或人工操作，通常数秒结束。扩展产品后可按实际能力更新演示路径；不要以打印预先保存的结果替代运行。

分开运行时，先 `npm run source`，来源监听 127.0.0.1:4101；在另一终端设置 SOURCE_URL=http://127.0.0.1:4101 后运行 `npm start`，产品默认 4102。DATA_DIR 可设置资料目录，PORT 可分别覆盖监听端口。构建产物位于 dist，当前脚本仅使用 Node 内置模块。

## 已有接口

兼容接口（GET 不会变为写操作；收件记录只包含单件 raw 对象，不代表关联资料已完整）：

- GET /health：服务状态。
- POST /intakes，JSON 为 {"path":"/primary"}：按现有 reader 接收单件原件；内容解释失败不登记资料。
- GET /records：持久接收目录；同 source URL、同摘要重领返回原 id。
- GET /objects/{digest}：读取已保存的单件原始字节。

production 交付接口：

- POST /productions，JSON 为 {"path":"/production"} 或 {"path":"/public"}：按一次交付整体接收。清单或 load file 结构非法返回 422 且不登记；资源不可达等业务问题不拒收，返回 201 并把问题登记在 `problems` 中，`status` 为 `accepted` 或 `accepted_with_issues`。
- GET /productions：全部交付收件记录（含 production id、可见性、家族、页码核对、资源链接摘要、问题清单）。
- GET /productions/{intakeId}：单次收件详情。
- GET /evidence/{evidenceId}：按证据身份（Bates）跨交付查询，分别列出每次交付的登记，不合并、不互授可见性。
- GET /production-objects/{digest}：读取本次交付已保存的资源字节；链接关系只存在于各自收件记录内。

## 来源与资料

交换范围、字段和边界见 [来源约定](docs/upstream.md)，样例资源清单可访问来源的 /catalog。`fixtures/upstream.json` 描述 HTTP 资源和阶段变体，不包含产品实现。GET /_requests 可查实际领取请求；POST /_phase 接收 {"phase":1} 切换已定义的来源状态，切回 0 恢复。所有资料都限于公开约定或本地合成数据，不向真实业务系统写入。

## 测试与构建

`npm test` 覆盖读取器、畸形输入、真实 HTTP 领取、原件一致性、持久重开、同源边界和范围响应；production 领域核对（家族、页码范围、重复归属、缺页、卷与资源声明、公开交付隔离）在 test/production.test.mjs，端到端收件在 test/production-integration.test.mjs，原有领域读取行为在 test/domain.test.mjs。`npm run build` 对运行模块逐个执行语法校验并复制到 dist。`docker build -t review-production:local .` 可创建产品运行镜像；镜像默认运行实际演示，不含远程业务凭据。
