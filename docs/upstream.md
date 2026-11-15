# 来源约定

## 产品交换范围

DAT 使用 UTF-8，U+00FE 包裹字段，U+0014 分隔字段，U+00AE 表示字段内换行；本交付不含转义 U+00FE。首行列名含 BEGDOC/ENDDOC/BEGATTACH/ENDATTACH/NATIVE/TEXT/VOLUME。OPT 为逗号分隔的 page-id,volume,path,document-break,folder-break,box-break,page-count，空字段保留，document-break=Y 开始文档。Bates 字符串是来源标识，不能从字符串算出一定存在的页；范围只用于核对 OPT 明列的页和交付声明。资源路径以 production 的 volumes 映射为基准，禁止跨交付私自找同名资源。/production 是 restricted、/public 是 public，各自有独立交付 id 和资源清单；共享 evidence id 或内容摘要不授予可见性。只接收本地合成资料，不处理真实案件或个人资料。

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

以上是格式或业务词汇的公开依据；本项目明确限定的交换子集以本文及实际资源为准，未要求完整标准实现。元数据和未支持声明应保留可定位的来源，不把未知转换成已确认的空结果。HTTP 来源状态、原件结构和产品接收完整性是不同层次；现有通用收件接口成功只表示该单件已保存。
