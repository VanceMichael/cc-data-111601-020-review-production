import { createHash, randomUUID } from 'node:crypto';

// 一次 production 的接收核对。
//
// 证据身份（Bates 文档号与页码）来自本次 DAT/OPT 与交付清单；
// 交付身份（production id、visibility）只属于本次清单。
// 资源仅按本次交付自己的声明领取，不按内容摘要跨交付复用或补全链接。
const VISIBILITIES = new Set(['restricted', 'public']);
const DAT_COLUMNS = ['BEGDOC', 'ENDDOC', 'BEGATTACH', 'ENDATTACH', 'NATIVE', 'TEXT', 'VOLUME'];
const ROLES = new Set(['native', 'text']);

function sourcePath(path) {
  if (typeof path !== 'string' || !path) return false;
  if (path.includes('..') || path.includes('\\') || path.startsWith('//')) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(path);
}

export function readManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('production_manifest');
  if (typeof value.id !== 'string' || !value.id.trim()) throw new Error('production_id');
  if (!VISIBILITIES.has(value.visibility)) throw new Error('production_visibility');
  for (const key of ['dat', 'opt']) {
    if (value[key] != null && (typeof value[key] !== 'string' || !value[key])) {
      throw new Error(`production_${key}`);
    }
  }
  const volumes = value.volumes ?? {};
  if (typeof volumes !== 'object' || Array.isArray(volumes)) throw new Error('production_volumes');
  for (const [volume, base] of Object.entries(volumes)) {
    if (!volume || typeof base !== 'string' || !base || !sourcePath(base)) throw new Error('production_volumes');
  }
  const resources = value.resources ?? {};
  if (typeof resources !== 'object' || Array.isArray(resources)) throw new Error('production_resources');
  for (const [role, path] of Object.entries(resources)) {
    if (!ROLES.has(role) || (path !== null && (typeof path !== 'string' || !path))) {
      throw new Error('production_resources');
    }
  }
  const evidenceIds = value.evidenceIds ?? [];
  if (!Array.isArray(evidenceIds) || evidenceIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('production_evidence');
  }
  // 顶层 native/text 是清单对单份资源的显式声明（null 表示明确不提供）。
  const single = {};
  for (const role of ROLES) {
    if (!Object.hasOwn(value, role)) continue;
    if (value[role] !== null && (typeof value[role] !== 'string' || !value[role])) {
      throw new Error('production_resources');
    }
    single[role] = value[role];
  }
  return { id: value.id, visibility: value.visibility,
    dat: value.dat ?? null, opt: value.opt ?? null,
    volumes: { ...volumes }, resources: { ...resources }, single,
    evidenceIds: evidenceIds.map(id => id.trim()) };
}

function bates(id) {
  const match = /^(.*?)(\d+)$/.exec(id);
  return match ? { prefix: match[1], number: Number(match[2]), width: match[2].length } : null;
}

// 只比较来源明确写出的端点。编号连续不代表中间的页存在，不能据此补齐。
function compare(left, right) {
  if (left === right) return 0;
  const a = bates(left); const b = bates(right);
  if (!a || !b || a.prefix !== b.prefix || a.width !== b.width) return null;
  return Math.sign(a.number - b.number);
}

function within(id, begin, end) {
  const lower = compare(id, begin); const upper = compare(id, end);
  return lower !== null && upper !== null && lower >= 0 && upper <= 0;
}

function after(left, right) {
  const order = compare(left, right);
  return order !== null && order > 0;
}

function rangesOverlap(left, right) {
  return within(left.begin, right.begin, right.end) || within(right.begin, left.begin, left.end)
    || within(left.end, right.begin, right.end) || within(right.end, left.begin, left.end);
}

// 资源路径必须落在本次交付的 volumes 映射内，不能跨交付找同名资源。
function volumePath(manifest, volume, relative, issues, context) {
  if (!Object.hasOwn(manifest.volumes, volume)) {
    issues.push({ code: 'volume_undeclared', volume, ...context });
    return null;
  }
  if (typeof relative !== 'string' || !relative) return null;
  const path = relative.replace(/^\/+/, '');
  if (!sourcePath(path)) {
    issues.push({ code: 'resource_path_invalid', volume, path: relative, ...context });
    return null;
  }
  const base = manifest.volumes[volume];
  return `${base.endsWith('/') ? base : `${base}/`}${path}`;
}

function collectDocuments(dat, issues) {
  const documents = [];
  const missing = DAT_COLUMNS.filter(name => !dat.columns.includes(name));
  if (missing.length) {
    issues.push({ code: 'dat_columns_incomplete', missing });
    return documents;
  }
  const columns = Object.fromEntries(dat.columns.map((name, index) => [name, index]));
  const firstRow = new Map();
  dat.rows.forEach((row, rowIndex) => {
    const value = name => (row[columns[name]] ?? '').trim();
    const begin = value('BEGDOC'); const end = value('ENDDOC');
    const familyBegin = value('BEGATTACH'); const familyEnd = value('ENDATTACH');
    const volume = value('VOLUME');
    if (!begin || !end || !familyBegin || !familyEnd || !volume) {
      issues.push({ code: 'dat_row_incomplete', rowIndex });
      return;
    }
    if (after(begin, end)) {
      issues.push({ code: 'document_range_invalid', rowIndex, evidenceId: begin, begin, end });
    }
    const familyOrder = compare(familyBegin, familyEnd);
    if (familyOrder === null) {
      issues.push({ code: 'family_range_incomparable', rowIndex,
        family: { begin: familyBegin, end: familyEnd } });
    } else if (familyOrder > 0) {
      issues.push({ code: 'family_range_invalid', rowIndex, family: { begin: familyBegin, end: familyEnd } });
    }
    // 端点在家族内可核对时明确报告越界；前缀或位数不可比时只说明无法核对。
    for (const [side, value] of [['begin', begin], ['end', end]]) {
      if (compare(value, familyBegin) === null || compare(value, familyEnd) === null) {
        issues.push({ code: 'document_family_incomparable', rowIndex, evidenceId: begin,
          side, value, family: { begin: familyBegin, end: familyEnd } });
      } else if (!within(value, familyBegin, familyEnd)) {
        issues.push({ code: 'document_outside_family', rowIndex, evidenceId: begin,
          side, value, family: { begin: familyBegin, end: familyEnd } });
      }
    }
    if (firstRow.has(begin)) {
      issues.push({ code: 'duplicate_document', evidenceId: begin, rowIndex, firstRow: firstRow.get(begin) });
    } else firstRow.set(begin, rowIndex);
    documents.push({
      evidenceId: begin, begin, end,
      family: { begin: familyBegin, end: familyEnd },
      role: begin === familyBegin ? 'primary' : 'attachment',
      volume, native: value('NATIVE') || null, text: value('TEXT') || null, rowIndex,
    });
  });
  documents.forEach((left, index) => {
    for (const right of documents.slice(index + 1)) {
      if (rangesOverlap(left, right)) {
        issues.push({ code: 'document_range_overlap', documents: [left.evidenceId, right.evidenceId],
          ranges: [{ begin: left.begin, end: left.end }, { begin: right.begin, end: right.end }] });
      }
    }
  });
  return documents;
}

function collectFamilies(documents, issues) {
  const families = new Map();
  for (const document of documents) {
    const key = `${document.family.begin}\u0000${document.family.end}`;
    if (!families.has(key)) {
      families.set(key, { begin: document.family.begin, end: document.family.end, documents: [] });
    }
    families.get(key).documents.push(document);
  }
  for (const family of families.values()) {
    family.evidenceIds = family.documents.map(document => document.evidenceId);
    family.volumes = [...new Set(family.documents.map(document => document.volume))].sort();
    family.primary = family.documents.some(document => document.evidenceId === family.begin)
      ? family.begin : null;
    if (!family.primary) {
      issues.push({ code: 'family_missing_primary', family: { begin: family.begin, end: family.end },
        delivered: family.evidenceIds });
    }
    let deliveredEnd = family.documents[0].end;
    for (const document of family.documents) {
      if (after(document.end, deliveredEnd)) deliveredEnd = document.end;
    }
    if (after(family.end, deliveredEnd)) {
      issues.push({ code: 'family_document_missing', family: { begin: family.begin, end: family.end },
        declaredEnd: family.end, deliveredEnd });
    }
    // 相邻两份已交付文档之间如果有间隔，只报告两侧端点，不列出中间的 Bates 号。
    const ordered = [...family.documents].sort((left, right) => {
      const order = compare(left.begin, right.begin);
      return order === null ? 0 : order;
    });
    for (let index = 0; index + 1 < ordered.length; index++) {
      const left = ordered[index]; const right = ordered[index + 1];
      const leftEnd = bates(left.end); const rightBegin = bates(right.begin);
      if (!leftEnd || !rightBegin || leftEnd.prefix !== rightBegin.prefix
        || leftEnd.width !== rightBegin.width) continue;
      // 只有“上一份结束号的下一号”恰好是“下一份起始号”才算紧邻；
      // 差一号以上只报告两侧端点，不列举中间的 Bates 号。
      if (rightBegin.number <= leftEnd.number + 1) continue;
      issues.push({ code: 'family_document_gap', family: { begin: family.begin, end: family.end },
        previous: { evidenceId: left.evidenceId, end: left.end },
        next: { evidenceId: right.evidenceId, begin: right.begin } });
    }
    if (ordered.length && after(ordered[0].begin, family.begin)) {
      issues.push({ code: 'family_document_missing', family: { begin: family.begin, end: family.end },
        missingAt: 'begin', declaredBegin: family.begin, deliveredBegin: ordered[0].begin });
    }
  }
  return [...families.values()];
}

function collectPages(documents, opt, issues, { ownershipKnown = true } = {}) {
  const groups = new Map();
  for (const page of opt.pages) {
    if (!groups.has(page.pageId)) groups.set(page.pageId, []);
    groups.get(page.pageId).push(page);
  }
  for (const [pageId, occurrences] of groups) {
    const owners = ownershipKnown
      ? documents.filter(document => within(pageId, document.begin, document.end)) : [];
    if (occurrences.length > 1) {
      // 同一页码在 OPT 中出现多次，归属不唯一。
      issues.push({ code: 'duplicate_page_number', pageId,
        occurrences: occurrences.length,
        paths: [...new Set(occurrences.map(page => page.path))] });
    }
    for (const page of occurrences) {
      page.owners = owners;
      page.ownerIds = owners.map(owner => owner.evidenceId);
      page.role = owners.length === 1 ? owners[0].role : null;
    }
    if (!ownershipKnown) continue;
    if (!owners.length) {
      issues.push({ code: 'page_unowned', pageId,
        volumes: [...new Set(occurrences.map(page => page.volume))],
        paths: [...new Set(occurrences.map(page => page.path))] });
    } else if (owners.length > 1) {
      issues.push({ code: 'duplicate_page_ownership', pageId,
        owners: owners.map(owner => owner.evidenceId) });
    }
    for (const page of occurrences) {
      if (owners.length === 1 && owners[0].volume !== page.volume) {
        issues.push({ code: 'page_volume_mismatch', pageId, pageVolume: page.volume,
          documentVolume: owners[0].volume, evidenceId: owners[0].evidenceId, path: page.path });
      }
    }
  }
  return opt.pages.map(page => ({ ...page, owners: page.owners ?? [],
    ownerIds: page.ownerIds ?? [], role: page.role ?? null }));
}

function checkDocumentPages(documents, pages, issues) {
  const owned = new Map(documents.map(document => [document, new Set()]));
  for (const page of pages) for (const owner of page.owners) owned.get(owner)?.add(page.pageId);
  const starts = new Set(pages.filter(page => page.documentBreak === 'Y').map(page => page.pageId));
  for (const document of documents) {
    const observed = owned.get(document) ?? new Set();
    if (!observed.size) {
      issues.push({ code: 'document_without_pages', evidenceId: document.evidenceId,
        begin: document.begin, end: document.end, volume: document.volume });
      continue;
    }
    // 文档起始页必须在 OPT 中实际出现，并由 document-break=Y 标出；
    // 不能因为 Bates 连续就假定起始页存在。
    if (!observed.has(document.begin)) {
      issues.push({ code: 'document_begin_page_missing', evidenceId: document.evidenceId,
        begin: document.begin, volume: document.volume,
        delivered: [...observed].sort() });
    } else if (!starts.has(document.begin)) {
      issues.push({ code: 'document_break_missing', evidenceId: document.evidenceId,
        begin: document.begin, volume: document.volume });
    }
    for (const pageId of observed) {
      if (starts.has(pageId) && pageId !== document.begin) {
        issues.push({ code: 'document_break_mismatch', pageId, evidenceId: document.evidenceId,
          begin: document.begin });
      }
    }
    const counts = [...new Set([...observed]
      .map(pageId => pages.find(page => page.pageId === pageId))
      .filter(page => page && page.pageCount !== null)
      .map(page => page.pageCount))];
    if (counts.length > 1) {
      issues.push({ code: 'page_count_conflict', evidenceId: document.evidenceId, declared: counts });
    } else if (counts.length === 1 && counts[0] !== observed.size) {
      // 只报告声明数与实际页数，不列出推测出来的缺失页码。
      issues.push({ code: 'page_count_mismatch', evidenceId: document.evidenceId,
        declared: counts[0], observed: observed.size });
    }
  }
  for (const page of pages) {
    if (page.documentBreak !== 'Y') continue;
    if (!page.owners.some(owner => owner.begin === page.pageId)) {
      issues.push({ code: 'document_break_unowned', pageId: page.pageId,
        owners: page.ownerIds, volumes: [page.volume] });
    }
  }
}

export function planProduction({ manifest, manifestPath = null, dat = null, opt = null,
  datIssue = null, optIssue = null, receiptId = null, receivedAt = new Date().toISOString() }) {
  const issues = [];
  if (datIssue) issues.push(datIssue);
  if (optIssue) issues.push(optIssue);

  const documents = dat ? collectDocuments(dat, issues) : [];
  const families = collectFamilies(documents, issues);
  // DAT 或 OPT 缺失时不能把“未知”当作“确认没有”：页归属与逐文档页数核对暂停，
  // 只保留仍可定位的来源问题。
  const ownershipKnown = Boolean(dat);
  const pages = opt ? collectPages(documents, opt, issues, { ownershipKnown }) : [];
  if (opt && dat) checkDocumentPages(documents, pages, issues);

  const declarations = new Map();
  const declare = (key, entry) => {
    if (!declarations.has(key)) declarations.set(key, { ...entry, key });
    return key;
  };

  // 资源只按本次交付自己的声明列出。
  // 公开交付只认 resources / 顶层 native、text 的显式声明；DAT 里写的原件
  // 即使与受限交付内容相同，也不领取、不复用链接，只留下声明缺失的收件问题。
  const resources = [];
  const addResource = (role, path, declaredBy, evidenceIds, context = {}) => {
    const key = declare(`${declaredBy}:${role}:${path}`, { role, path, declaredBy, ...context });
    if (!resources.some(resource => resource.key === key)) {
      resources.push({ key, role, path, declaredBy, evidenceIds });
    }
    return key;
  };

  if (manifest.visibility === 'restricted' && dat) {
    for (const document of documents) {
      for (const role of ROLES) {
        const relative = document[role];
        if (!relative) continue;
        const path = volumePath(manifest, document.volume, relative, issues,
          { evidenceId: document.evidenceId, role, volume: document.volume });
        if (!path) continue;
        document[`${role}Key`] = addResource(role, path, 'dat', [document.evidenceId],
          { evidenceId: document.evidenceId, volume: document.volume });
      }
    }
  } else if (dat) {
    // 公开交付的 DAT 仍提供证据身份与页码，但不提供资源链接。
    // 只有清单对某个角色完全没有表态时才记问题；显式 null 视为明确不提供。
    const declaredRoles = new Set([...Object.keys(manifest.resources), ...Object.keys(manifest.single)]);
    for (const document of documents) {
      for (const role of ROLES) {
        if (!document[role] || declaredRoles.has(role)) continue;
        issues.push({ code: 'resource_not_declared', role, path: document[role],
          evidenceId: document.evidenceId, declaredBy: 'dat',
          reason: 'public_delivery_declaration_required' });
      }
    }
  }
  for (const [role, path] of Object.entries(manifest.resources)) {
    if (typeof path !== 'string') continue;
    if (!sourcePath(path)) {
      issues.push({ code: 'resource_path_invalid', role, path, declaredBy: 'manifest' });
      continue;
    }
    addResource(role, path, 'manifest', [...manifest.evidenceIds]);
  }
  for (const [role, path] of Object.entries(manifest.single)) {
    if (typeof path !== 'string') continue;
    if (!sourcePath(path)) {
      issues.push({ code: 'resource_path_invalid', role, path, declaredBy: 'manifest' });
      continue;
    }
    const conflict = manifest.resources[role];
    if (typeof conflict === 'string' && conflict !== path) {
      issues.push({ code: 'resource_declaration_conflict', role,
        paths: [conflict, path], evidenceIds: [...manifest.evidenceIds] });
    }
    addResource(role, path, 'manifest', [...manifest.evidenceIds]);
  }

  for (const page of pages) {
    const path = volumePath(manifest, page.volume, page.path, issues,
      { pageId: page.pageId, role: 'page-image', volume: page.volume });
    page.imagePath = path;
    page.imageKey = path ? declare(`opt:page-image:${page.pageId}:${path}`, {
      role: 'page-image', path, declaredBy: 'opt', pageId: page.pageId, volume: page.volume }) : null;
  }
  // 同一图像文件被多个页码声明时，无法确定它实际属于哪一页，不能静默共用。
  const imageUse = new Map();
  for (const page of pages) {
    if (!page.imagePath) continue;
    if (!imageUse.has(page.imagePath)) imageUse.set(page.imagePath, []);
    imageUse.get(page.imagePath).push(page.pageId);
  }
  for (const [path, pageIds] of imageUse) {
    if (pageIds.length > 1) {
      issues.push({ code: 'page_image_reused', path, pageIds: [...new Set(pageIds)] });
    }
  }

  return {
    manifest, manifestPath, receiptId: receiptId ?? randomUUID(), receivedAt,
    delivery: { id: manifest.id, visibility: manifest.visibility },
    scope: { dat: Boolean(dat), opt: Boolean(opt),
      volumes: Object.keys(manifest.volumes).sort(),
      declaredRoles: [...new Set([...Object.keys(manifest.resources), ...Object.keys(manifest.single)])].sort() },
    documents, families, pages, resources, declarations: [...declarations.values()], issues,
  };
}

export function finalizeProduction(planned, outcomes) {
  const issues = [...planned.issues];
  const received = (key, fallback) => {
    const outcome = outcomes.get(key);
    if (!outcome) return fallback;
    return { ...fallback, ...outcome };
  };

  const resources = planned.resources.map(resource => {
    const outcome = received(resource.key, { status: 'not_received' });
    if (outcome.status === 'received') {
      return { ...resource, status: 'received', digest: outcome.digest, bytes: outcome.bytes };
    }
    issues.push({ code: 'resource_missing', role: resource.role, path: resource.path,
      evidenceIds: resource.evidenceIds, declaredBy: resource.declaredBy, reason: outcome.error });
    return { ...resource, status: outcome.status, error: outcome.error };
  });

  const pages = planned.pages.map(page => {
    if (!page.imageKey) return { ...page, image: { status: 'undeclared', path: null } };
    const outcome = received(page.imageKey, { status: 'not_received' });
    if (outcome.status === 'received') {
      return { ...page, image: { status: 'received', path: page.imagePath,
        digest: outcome.digest, bytes: outcome.bytes } };
    }
    issues.push({ code: 'page_image_missing', pageId: page.pageId, volume: page.volume,
      path: page.imagePath, evidenceIds: page.ownerIds, reason: outcome.error });
    return { ...page, image: { status: outcome.status, path: page.imagePath, error: outcome.error } };
  });

  const missingPages = new Set(issues.filter(issue => issue.code === 'page_image_missing')
    .map(issue => issue.pageId));
  const missingDocuments = new Set(issues.filter(issue => issue.code === 'document_without_pages')
    .map(issue => issue.evidenceId));
  const missingResources = new Set(issues.filter(issue => issue.code === 'resource_missing')
    .flatMap(issue => issue.evidenceIds ?? []));
  // 声明页数不足、起始页或 document-break 缺失也是家族不齐，但只按证据号报告，
  // 不把推断出来的页码写进家族问题。
  const incompleteDocuments = new Set(issues.filter(issue => [
    'page_count_mismatch', 'page_count_conflict', 'document_begin_page_missing',
    'document_break_missing', 'document_break_mismatch',
  ].includes(issue.code)).map(issue => issue.evidenceId).filter(Boolean));
  const truncatedFamilies = new Set(issues.filter(issue => issue.code === 'family_document_missing')
    .map(issue => `${issue.family.begin}\u0000${issue.family.end}`));
  for (const family of planned.families) {
    const inFamily = id => family.evidenceIds.includes(id);
    const familyMissingPages = [...new Set(planned.pages
      .filter(page => page.ownerIds.some(inFamily) && missingPages.has(page.pageId))
      .map(page => page.pageId))];
    const familyMissingDocuments = family.evidenceIds.filter(id => missingDocuments.has(id));
    const familyIncompleteDocuments = family.evidenceIds.filter(id => incompleteDocuments.has(id));
    const familyMissingResources = [...missingResources].filter(inFamily);
    const truncated = truncatedFamilies.has(`${family.begin}\u0000${family.end}`);
    if (!familyMissingPages.length && !familyMissingDocuments.length
      && !familyIncompleteDocuments.length && !familyMissingResources.length && !truncated) continue;
    // 只有跨卷家族才用 family_volume_incomplete；单卷的页数或端点问题
    // 已由 page_count_mismatch、family_document_missing 等具体问题表示。
    if (family.volumes.length < 2) continue;
    issues.push({ code: 'family_volume_incomplete',
      family: { begin: family.begin, end: family.end }, volumes: family.volumes,
      missingPages: familyMissingPages, missingDocuments: familyMissingDocuments,
      incompleteDocuments: familyIncompleteDocuments, missingResources: familyMissingResources,
      declaredEndDelivered: !truncated });
  }

  // 证据身份按 Bates 文档号聚合；交付身份只出现在 delivery 字段，两者不混用。
  const evidence = new Map();
  const touch = evidenceId => {
    if (!evidence.has(evidenceId)) {
      evidence.set(evidenceId, { evidenceId, role: 'declared', family: null,
        volumes: [], ranges: [], pages: [], resources: [] });
    }
    return evidence.get(evidenceId);
  };
  for (const document of planned.documents) {
    const entry = touch(document.evidenceId);
    if (document.role === 'primary') entry.role = 'primary';
    else if (entry.role === 'declared') entry.role = 'attachment';
    entry.family = document.family;
    if (!entry.volumes.includes(document.volume)) entry.volumes.push(document.volume);
    entry.ranges.push({ begin: document.begin, end: document.end, volume: document.volume });
  }
  for (const resource of resources) {
    if (resource.role === 'page-image') continue;
    for (const evidenceId of resource.evidenceIds) {
      touch(evidenceId).resources.push({ role: resource.role, path: resource.path,
        status: resource.status, digest: resource.digest ?? null });
    }
  }
  for (const evidenceId of planned.manifest.evidenceIds) touch(evidenceId);
  for (const page of pages) {
    for (const ownerId of page.ownerIds) {
      const entry = touch(ownerId);
      if (!entry.pages.includes(page.pageId)) entry.pages.push(page.pageId);
    }
  }

  const unique = [];
  const seen = new Set();
  for (const issue of issues) {
    const key = JSON.stringify(issue);
    if (seen.has(key)) continue;
    seen.add(key); unique.push(issue);
  }
  return {
    id: planned.receiptId,
    receiptId: planned.receiptId,
    receivedAt: planned.receivedAt,
    manifest: planned.manifestPath,
    scope: planned.scope,
    delivery: {
      id: planned.delivery.id,
      visibility: planned.delivery.visibility,
      declared: { ...planned.manifest.single },
    },
    evidence: [...evidence.values()],
    pages: pages.map(page => ({
      pageId: page.pageId, volume: page.volume, path: page.path,
      documentBreak: page.documentBreak, folderBreak: page.folderBreak, boxBreak: page.boxBreak,
      pageCount: page.pageCount, document: page.ownerIds.length === 1 ? page.ownerIds[0] : null,
      documents: page.owners.map(owner => ({ evidenceId: owner.evidenceId, role: owner.role })),
      role: page.role,
      image: page.image.status === 'received'
        ? { status: 'received', path: page.image.path, digest: page.image.digest, bytes: page.image.bytes.length }
        : { status: page.image.status, path: page.image.path ?? null, error: page.image.error ?? null },
    })),
    resources: resources.map(resource => ({
      role: resource.role, path: resource.path, declaredBy: resource.declaredBy,
      evidenceIds: resource.evidenceIds, status: resource.status,
      digest: resource.digest ?? null,
      bytes: resource.status === 'received' ? resource.bytes.length : null,
      error: resource.error ?? null,
    })),
    issues: unique,
    complete: unique.length === 0,
  };
}

export function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
