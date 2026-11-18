# 来源约定

## 产品交换范围

DAT 使用 UTF-8，U+00FE 包裹字段，U+0014 分隔字段，U+00AE 表示字段内换行；本交付不含转义 U+00FE。首行列名含 BEGDOC/ENDDOC/BEGATTACH/ENDATTACH/NATIVE/TEXT/VOLUME。OPT 为逗号分隔的 page-id,volume,path,document-break,folder-break,box-break,page-count，空字段保留，document-break=Y 开始文档。Bates 字符串是来源标识，不能从字符串算出一定存在的页；范围只用于核对 OPT 明列的页和交付声明。资源路径以 production 的 volumes 映射为基准，禁止跨交付私自找同名资源。/production 是 restricted、/public 是 public，各自有独立交付 id 和资源清单；共享 evidence id 或内容摘要不授予可见性。只接收本地合成资料，不处理真实案件或个人资料。

## 一次 production 的接收约定

POST /productions 的 JSON 为 `{"manifest":"/production"}`，产品按该清单领取 DAT、OPT 与资源，返回本次收件记录。记录分层保存：

- `receiptId`／`receivedAt`：本次收件的身份，每次接收都不同。
- `delivery`：清单声明的 production id、visibility，以及顶层 `native`／`text` 的显式声明（`null` 表示明确不提供）。
- `evidence`：按 Bates 文档号聚合的证据身份，含主件／附件角色、家族端点、卷、文档区间与该证据已交付的页码。
- `pages`：OPT 明列的页码及其唯一文档归属、图像资源状态。
- `resources`：本次清单声明并实际领取的原生／文本资源。
- `issues`：可定位的收件问题，`complete` 表示问题列表为空。

核对规则：

- 家族（BEGATTACH–ENDATTACH）内每份文档、每个卷、每页图像与已声明资源都要在本次交付中齐备；跨卷家族缺任何一件时记 `family_volume_incomplete`，并只列出实际缺失的页码或证据号。
- 同一页码在 OPT 重复出现记 `duplicate_page_number`；页码同时落在多份文档记 `duplicate_page_ownership`；页码不属于任何文档记 `page_unowned`。
- 声明的 `page-count` 与实际 OPT 页数不一致时只记数量差异，不按连续 Bates 补齐或列出推测页码。文档起始页、document-break 与 DAT 端点不一致时分别记 `document_begin_page_missing`、`document_break_missing`、`document_break_mismatch`。
- 同一图像文件被多个页码声明记 `page_image_reused`，不静默共用。
- restricted 交付按 DAT 的 NATIVE/TEXT 声明资源；public 交付只领取清单 `resources` 或顶层声明中的路径。公开交付的 DAT 即使写着受限原件，也不领取、不复用其链接：清单未表态时记 `resource_not_declared`，显式 `null` 视为明确不提供。资源只按路径领取，不按内容摘要匹配。
- 资源领取失败记 `resource_missing` 或 `page_image_missing` 并保留来源状态，不用空字节或相邻页替代。

## 当前来源路由

- `/primary`：application/octet-stream
- `/images.opt`：text/plain
- `/VOL1/native/parent.txt`：text/plain
- `/VOL1/text/parent.txt`：text/plain
- `/VOL2/native/child.txt`：text/plain
- `/VOL2/text/child.txt`：text/plain
- `/VOL1/images/1.tif`：text/plain
- `/VOL1/images/2.tif`：text/plain
- `/VOL2/images/3.tif`：text/plain
- `/PUBLIC/text/parent.txt`：text/plain
- `/production`：application/json
- `/public`：application/json

`/catalog` 提供入口及业务选择。资源字节支持 GET/HEAD、单一 bytes 范围、ETag 和 If-Match，响应不会跨来源重定向。`/_phase` 为联调控制路径，不是产品数据来源，不应由产品自行切换阶段。

## 依据和范围说明

- https://www.relativity.com/resources/

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；通用收件接口成功只表示该单件已保存，production 收件记录的 `complete` 才表示本次交付核对无问题。
