import { createHash } from 'node:crypto';
import { inspect, optRows } from './reader.mjs';

const DAT_COLUMNS = ['BEGDOC', 'ENDDOC', 'BEGATTACH', 'ENDATTACH', 'NATIVE', 'TEXT', 'VOLUME'];

export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
export function parseManifest(bytes) {
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('manifest_json'); }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest_shape');
  if (typeof manifest.id !== 'string' || !manifest.id) throw new Error('manifest_id');
  if (typeof manifest.visibility !== 'string' || !manifest.visibility) throw new Error('manifest_visibility');
  return manifest;
}
export function volumeBase(manifest, volume) {
  const base = manifest.volumes?.[volume];
  if (typeof base !== 'string' || !base) throw new Error('volume_undeclared');
  // 卷基址只允许同源根相对路径；带协议或跨目录段直接拒绝，跨源由 transport 再拦一道
  if (base.includes('://') || base.split('/').includes('..')) throw new Error('volume_base_invalid');
  return base.endsWith('/') ? base : `${base}/`;
}
export function joinResource(base, relative) {
  if (typeof relative !== 'string' || !relative || relative.startsWith('/')
    || relative.includes('://') || relative.split('/').includes('..')) {
    throw new Error('resource_path_invalid');
  }
  return `${base}${relative}`;
}
const tag = (code, detail) => ({ code, detail });

async function loadDeclared(loader, sourcePath, problems, blobMap) {
  const acquired = await loader(sourcePath);
  if (acquired.status !== 'ok') {
    problems.push(tag('resource_unavailable', { resource: sourcePath, reason: acquired.reason }));
    return null;
  }
  const digest = digestOf(acquired.bytes);
  blobMap.set(digest, acquired.bytes);
  return { sourcePath, digest, bytes: acquired.bytes.length };
}

// 整份 production（含 DAT/OPT/卷映射）的接收核对。所有结论只基于交付清单与 load file
// 明列的内容；Bates 字符串是来源标识，绝不按连续页码推测未列出的页。
export async function analyzeFullProduction({ manifest, manifestPath, manifestBytes, datBytes, optBytes, loader }) {
  if (typeof manifest.dat !== 'string') throw new Error('manifest_dat');
  if (typeof manifest.opt !== 'string') throw new Error('manifest_opt');
  if (manifest.volumes !== null && (typeof manifest.volumes !== 'object' || Array.isArray(manifest.volumes))) {
    throw new Error('manifest_volumes_shape');
  }
  const problems = [];
  const blobMap = new Map();
  const manifestDigest = digestOf(manifestBytes);
  const datDigest = digestOf(datBytes);
  const optDigest = digestOf(optBytes);

  const parsed = inspect(datBytes);
  const columns = parsed.columns;
  const indexOf = name => columns.indexOf(name);
  if (DAT_COLUMNS.some(name => !columns.includes(name))) throw new Error('dat_columns');
  const iBeg = indexOf('BEGDOC'), iEnd = indexOf('ENDDOC'),
    iBegAtt = indexOf('BEGATTACH'), iEndAtt = indexOf('ENDATTACH'),
    iNative = indexOf('NATIVE'), iText = indexOf('TEXT'), iVolume = indexOf('VOLUME');

  const documents = parsed.rows.map((row, rowIndex) => {
    const value = column => row[indexOf(column)];
    const document = {
      rowIndex,
      documentId: row[iBeg],
      begDoc: row[iBeg], endDoc: row[iEnd],
      begAttach: row[iBegAtt], endAttach: row[iEndAtt],
      volume: row[iVolume],
      nativeRelative: row[iNative] || null,
      textRelative: row[iText] || null,
      familyId: '', role: 'parent',
    };
    for (const field of ['BEGDOC', 'ENDDOC', 'BEGATTACH', 'ENDATTACH', 'VOLUME']) {
      if (!value(field)) problems.push(tag('dat_field_empty', { row: rowIndex + 2, field }));
    }
    return document;
  });
  const byBeg = new Map();
  for (const document of documents) {
    if (byBeg.has(document.begDoc)) {
      problems.push(tag('document_duplicate', { documentId: document.begDoc, rows: [byBeg.get(document.begDoc).rowIndex + 2, document.rowIndex + 2] }));
    } else byBeg.set(document.begDoc, document);
  }

  // OPT：只认真实列出的 page-id；document-break=Y 开始一份新文档。
  // 同一 page-id 重复出现即"同一页码重复归属"，保留首次出现位置用于定位。
  const opt = optRows(optBytes.toString('utf8'));
  for (const row of opt) {
    if (!row.pageId || !row.volume || !row.path) {
      problems.push(tag('opt_field_empty', { row: row.rowIndex + 1, field: !row.pageId ? 'page-id' : !row.volume ? 'volume' : 'path' }));
    }
  }
  const seenPage = new Map();
  for (const row of opt) {
    if (seenPage.has(row.pageId)) {
      problems.push(tag('page_duplicate_attribution', { pageId: row.pageId, rows: [seenPage.get(row.pageId) + 1, row.rowIndex + 1] }));
    } else seenPage.set(row.pageId, row.rowIndex);
  }
  const groups = [];
  for (const row of opt) {
    if (row.documentBreak === 'Y' || groups.length === 0) {
      if (groups.length === 0 && row.documentBreak !== 'Y') problems.push(tag('opt_first_break', { row: row.rowIndex + 1 }));
      groups.push({ begDoc: row.pageId, volume: row.volume, pages: [] });
    }
    const group = groups[groups.length - 1];
    let declaredPageCount = null;
    if (row.pageCount !== '') {
      const parsedCount = Number(row.pageCount);
      if (!Number.isInteger(parsedCount) || parsedCount <= 0) {
        problems.push(tag('page_count_invalid', { row: row.rowIndex + 1, value: row.pageCount }));
      } else declaredPageCount = parsedCount;
    }
    group.pages.push({ pageId: row.pageId, volume: row.volume, imageRelative: row.path,
      declaredPageCount, rowIndex: row.rowIndex });
  }

  const groupByBeg = new Map();
  for (const group of groups) {
    if (groupByBeg.has(group.begDoc)) problems.push(tag('document_duplicate', { documentId: group.begDoc }));
    groupByBeg.set(group.begDoc, group);
  }

  // DAT 声明范围与 OPT 明列页逐页核对（不做任何数字连续性推测）
  for (const document of documents) {
    const group = groupByBeg.get(document.begDoc);
    if (!group) {
      problems.push(tag('page_missing_from_opt', { documentId: document.begDoc, range: [document.begDoc, document.endDoc] }));
      continue;
    }
    const optIds = group.pages.map(page => page.pageId);
    const firstId = optIds[0], lastId = optIds[optIds.length - 1];
    if (firstId !== document.begDoc || lastId !== document.endDoc) {
      problems.push(tag('page_range_mismatch', { documentId: document.begDoc,
        declared: [document.begDoc, document.endDoc], observed: [firstId, lastId] }));
    }
    const breakRow = group.pages[0];
    if (breakRow.declaredPageCount !== null && breakRow.declaredPageCount !== optIds.length) {
      problems.push(tag('page_count_mismatch', { documentId: document.begDoc,
        declared: breakRow.declaredPageCount, observed: optIds.length }));
    }
    for (const page of group.pages) {
      if (page.volume !== document.volume) {
        problems.push(tag('page_volume_mismatch', { pageId: page.pageId,
          datVolume: document.volume, optVolume: page.volume }));
      }
    }
  }
  for (const group of groups) {
    if (!byBeg.has(group.begDoc)) {
      problems.push(tag('page_unclaimed', { pageIds: group.pages.map(page => page.pageId) }));
    }
  }

  // 家族：按 DAT 声明的 BEGATTACH/ENDATTACH 核对成员、顺序与跨卷完整性
  const familyMap = new Map();
  for (const document of documents) {
    const key = `${document.begAttach}..${document.endAttach}`;
    if (!familyMap.has(key)) familyMap.set(key, []);
    familyMap.get(key).push(document);
  }
  const ordered = [...documents].sort((a, b) => a.begDoc.localeCompare(b.begDoc));
  const positionById = new Map(ordered.map((document, index) => [document.begDoc, index]));
  const families = [];
  for (const [key, members] of familyMap) {
    const sorted = [...members].sort((a, b) => a.begDoc.localeCompare(b.begDoc));
    const parent = sorted.find(member => member.begDoc === member.begAttach) ?? sorted[0];
    const familyId = parent.begDoc;
    const family = { familyId, members: [], volumes: [], complete: true };
    for (const member of sorted) {
      member.familyId = familyId;
      member.role = member.begDoc === familyId ? 'parent' : 'attachment';
      family.members.push(member.begDoc);
      if (!family.volumes.includes(member.volume)) family.volumes.push(member.volume);
      if (member.begAttach !== parent.begAttach || member.endAttach !== parent.endAttach) {
        problems.push(tag('family_declaration_inconsistent', { familyId, documentId: member.begDoc }));
        family.complete = false;
      }
      if (!groupByBeg.has(member.begDoc)) family.complete = false;
    }
    const positions = sorted.map(member => positionById.get(member.begDoc));
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] !== positions[i - 1] + 1) {
        problems.push(tag('family_incomplete', { familyId, reason: 'members_not_contiguous',
          expectedBetween: [ordered[positions[i - 1]].begDoc, ordered[positions[i]].begDoc] }));
        family.complete = false;
      }
    }
    families.push(family);
  }

  // 卷映射必须由本 production 清单声明；禁止跨交付找同名资源
  const volumeBases = new Map();
  for (const document of documents) {
    if (volumeBases.has(document.volume)) continue;
    try { volumeBases.set(document.volume, volumeBase(manifest, document.volume)); }
    catch (error) {
      problems.push(tag(error.message, { volume: document.volume }));
      volumeBases.set(document.volume, null);
    }
  }

  // 图像页核对：逐页按卷映射取 OPT 明列的图像
  const pages = [];
  for (const group of groups) {
    const owner = byBeg.get(group.begDoc);
    for (const page of group.pages) {
      const entry = { pageId: page.pageId, volume: page.volume, documentId: group.begDoc,
        familyId: owner?.familyId ?? '', image: null, imageSourcePath: null };
      const base = volumeBases.get(page.volume);
      if (base === null || base === undefined) {
        problems.push(tag('volume_undeclared', { volume: page.volume, pageId: page.pageId }));
      } else {
        let imagePath;
        try { imagePath = joinResource(base, page.imageRelative); }
        catch (error) { problems.push(tag(error.message, { pageId: page.pageId, relative: page.imageRelative })); }
        if (imagePath) {
          entry.imageSourcePath = imagePath;
          entry.image = await loadDeclared(loader, imagePath, problems, blobMap);
        }
      }
      pages.push(entry);
    }
  }

  // 原生/文本资源核对：空字段等于未声明，绝不领取、绝不链接
  const evidenceResources = [];
  for (const document of documents) {
    const base = volumeBases.get(document.volume);
    const entry = { documentId: document.begDoc, familyId: document.familyId,
      native: null, nativeSourcePath: null, text: null, textSourcePath: null };
    for (const kind of ['native', 'text']) {
      const relative = kind === 'native' ? document.nativeRelative : document.textRelative;
      if (!relative) continue;
      if (base === null || base === undefined) {
        problems.push(tag('volume_undeclared', { volume: document.volume, documentId: document.begDoc }));
        continue;
      }
      let resourcePath;
      try { resourcePath = joinResource(base, relative); }
      catch (error) { problems.push(tag(error.message, { documentId: document.begDoc, relative })); continue; }
      entry[`${kind}SourcePath`] = resourcePath;
      entry[kind] = await loadDeclared(loader, resourcePath, problems, blobMap);
    }
    evidenceResources.push(entry);
  }

  // 家族完整性问题补挂 familyId，便于按证据定位收件问题
  const pageFamily = new Map(pages.map(page => [page.pageId, page.familyId]));
  const documentFamily = new Map(documents.map(document => [document.documentId, document.familyId]));
  for (const problem of problems) {
    const detail = problem.detail;
    if (!detail) continue;
    if (!detail.familyId) {
      detail.familyId = detail.pageId ? pageFamily.get(detail.pageId)
        : (detail.documentId ? documentFamily.get(detail.documentId) : detail.familyId);
    }
    if (!detail.familyId && detail.resource) {
      const page = pages.find(item => item.imageSourcePath === detail.resource);
      if (page) detail.familyId = page.familyId;
      const owner = evidenceResources.find(item =>
        item.nativeSourcePath === detail.resource || item.textSourcePath === detail.resource);
      if (owner) detail.familyId = documentFamily.get(owner.documentId);
    }
  }
  // 家族是否完整只按已登记事实汇总：成员缺页、范围不符、卷未声明或资源不可达均视为未齐，
  // 不通过 Bates 数字连续性反推任何未在 DAT/OPT 中出现的页。
  const incompleteFamilyIds = new Set();
  for (const problem of problems) {
    if (problem.detail?.familyId) incompleteFamilyIds.add(problem.detail.familyId);
  }
  for (const family of families) family.complete = family.complete && !incompleteFamilyIds.has(family.familyId);

  const evidenceIds = [...new Set(documents.map(document => document.begDoc))];
  const declaredVolumes = Object.keys(manifest.volumes ?? {});
  return {
    kind: 'full',
    productionId: manifest.id,
    visibility: manifest.visibility,
    manifest: { sourcePath: manifestPath, digest: manifestDigest },
    datDigest, optDigest,
    status: problems.length ? 'accepted_with_issues' : 'accepted',
    problems,
    documents: documents.map(({ rowIndex, ...rest }) => rest),
    families,
    pages,
    evidenceResources,
    evidenceIds,
    volumes: { declared: declaredVolumes, observed: [...new Set(documents.map(document => document.volume))] },
    blobs: blobMap,
  };
}

// 公开（脱敏）交付：只建立清单显式声明的链接；native 为 null 即永久无原件链接，
// 即使受限交付中存在同摘要字节也不自动复用。
export async function analyzePublicDelivery({ manifest, manifestPath, manifestBytes, loader }) {
  if (manifest.native !== null && manifest.native !== undefined) throw new Error('public_native_must_be_null');
  if (!Array.isArray(manifest.evidenceIds)) throw new Error('manifest_evidence_ids');
  if (manifest.resources !== null && (typeof manifest.resources !== 'object' || Array.isArray(manifest.resources))) {
    throw new Error('manifest_resources_shape');
  }
  const problems = [];
  const blobMap = new Map();
  const resources = {};
  for (const [kind, sourcePath] of Object.entries(manifest.resources ?? {})) {
    if (typeof sourcePath !== 'string' || !sourcePath.startsWith('/')) {
      throw new Error('resource_path_invalid');
    }
    resources[kind] = await loadDeclared(loader, sourcePath, problems, blobMap);
  }
  const evidence = manifest.evidenceIds.map(evidenceId => ({
    evidenceId,
    productionId: manifest.id,
    nativeLinked: false,
    resourceKinds: Object.keys(resources),
  }));
  return {
    kind: 'public',
    productionId: manifest.id,
    visibility: manifest.visibility,
    manifest: { sourcePath: manifestPath, digest: digestOf(manifestBytes) },
    status: problems.length ? 'accepted_with_issues' : 'accepted',
    problems,
    evidenceIds: [...manifest.evidenceIds],
    evidence,
    resources,
    blobs: blobMap,
  };
}
