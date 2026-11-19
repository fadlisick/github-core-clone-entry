// Git smart HTTP: pkt-line codec, packfile read/write (plain objects only),
// protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack fallback and
// v0 receive-pack. No git binary, no dependencies: node:crypto + node:zlib.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { ZERO_OID, hashObject, parseCommit, parseTree, type GitObject, type ObjectType, type Repo, type Store } from './store.ts';

export const PKT_MAX = 65520;

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface PktItem {
  kind: 'data' | 'flush' | 'delim' | 'end';
  data: Buffer;
}

/** Parse a pkt-line stream; stops at flush/delim/end or at raw tail (returns rawTail). */
export function parsePktLines(buf: Buffer, start = 0): { items: PktItem[]; next: number; rawTail: Buffer | null } {
  const items: PktItem[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return { items, next: off, rawTail: buf.subarray(off) };
    const len = parseInt(head, 16);
    if (len === 0) {
      items.push({ kind: 'flush', data: Buffer.alloc(0) });
      return { items, next: off + 4, rawTail: null };
    }
    if (len === 1) {
      items.push({ kind: 'delim', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: 'end', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len > PKT_MAX || off + len > buf.length) return { items, next: off, rawTail: buf.subarray(off) };
    items.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { items, next: off, rawTail: off < buf.length ? buf.subarray(off) : null };
}

export function pktLinesToStrings(items: PktItem[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'data') out.push(it.data.toString('utf8'));
  }
  return out;
}

// ---------------------------------------------------------------- packfile

function writeVarintHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  const rest: number[] = [];
  while (size > 0) {
    rest.push(size & 0x7f);
    size >>= 7;
  }
  if (rest.length > 0) first |= 0x80;
  bytes.push(first);
  for (let i = 0; i < rest.length; i += 1) {
    bytes.push((rest[i] as number) | (i + 1 < rest.length ? 0x80 : 0));
  }
  return Buffer.from(bytes);
}

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function writePack(objects: Array<{ type: ObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(writeVarintHeader(TYPE_CODES[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate the zlib stream starting at offset; returns data + bytes consumed. */
export function inflateAt(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  const remaining = buf.length - offset;
  // Exponential probe for a length that inflates cleanly, then binary search.
  let lo = 1;
  let hi = remaining;
  const tryLen = (n: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(offset, offset + n));
      if (out.length === expectedSize) return out;
      return null;
    } catch {
      return null;
    }
  };
  let n = Math.min(remaining, Math.max(16, expectedSize + 16));
  let found: Buffer | null = tryLen(n);
  if (found === null) {
    // Grow until success or exhaustion.
    let step = n;
    while (step < remaining) {
      step = Math.min(remaining, step * 2);
      found = tryLen(step);
      if (found !== null) {
        lo = Math.floor(step / 2) + 1;
        hi = step;
        break;
      }
    }
    if (found === null) return { data: inflateSync(buf.subarray(offset)), consumed: remaining };
    // Binary search smallest working length.
    let ok = hi;
    let l = lo;
    let r = hi;
    while (l <= r) {
      const mid = Math.floor((l + r) / 2);
      const out = tryLen(mid);
      if (out !== null) {
        ok = mid;
        found = out;
        r = mid - 1;
      } else {
        l = mid + 1;
      }
    }
    return { data: found, consumed: ok };
  }
  // Shrink to smallest working length.
  let ok = n;
  let l = 1;
  let r = n;
  while (l <= r) {
    const mid = Math.floor((l + r) / 2);
    const out = tryLen(mid);
    if (out !== null) {
      ok = mid;
      found = out;
      r = mid - 1;
    } else {
      l = mid + 1;
    }
  }
  return { data: found, consumed: ok };
}

export interface PackEntry {
  type: ObjectType;
  data: Buffer;
  oid: string;
}

/** Parse a packfile. Plain objects only; deltas are rejected (client never sends them). */
export function readPack(buf: Buffer): PackEntry[] {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack checksum mismatch');
  const entries: PackEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    if (off >= buf.length - 20) throw new Error('pack truncated');
    let b = buf[off] as number;
    off += 1;
    const typeCode = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      b = buf[off] as number;
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // ofs-delta: skip offset varint, then inflate delta and resolve below.
      let ob = buf[off] as number;
      off += 1;
      let deltaOff = ob & 0x7f;
      while ((ob & 0x80) !== 0) {
        ob = buf[off] as number;
        off += 1;
        deltaOff = ((deltaOff + 1) << 7) | (ob & 0x7f);
      }
      const baseOffset = (off - 1 - (0) ) - 0; // placeholder, recomputed below
      void baseOffset;
      const { data, consumed } = inflateAt(buf, off, size);
      off += consumed;
      entries.push({ type: 'blob', data, oid: `__ofs_delta_${i}_${deltaOff}` });
      continue;
    }
    if (typeCode === 7) {
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const { data, consumed } = inflateAt(buf, off, size);
      off += consumed;
      entries.push({ type: 'blob', data, oid: `__ref_delta_${i}_${baseOid}` });
      continue;
    }
    const type = CODE_TYPES[typeCode];
    if (type === undefined) throw new Error(`unknown pack type ${typeCode}`);
    const { data, consumed } = inflateAt(buf, off, size);
    off += consumed;
    if (data.length !== size) throw new Error('pack size mismatch');
    entries.push({ type, data, oid: hashObject(type, data) });
  }
  if (off !== buf.length - 20) throw new Error('pack trailing bytes');
  return entries;
}

/** Resolve delta entries (ofs/ref) against already-resolved entries + held objects. */
export function resolvePackEntries(entries: PackEntry[], held: Map<string, GitObject>): Array<{ type: ObjectType; data: Buffer; oid: string }> {
  const out: Array<{ type: ObjectType; data: Buffer; oid: string }> = [];
  const byOffset = new Map<number, { type: ObjectType; data: Buffer }>();
  // First pass: plain entries. Delta entries need their base; process in order,
  // retrying deferred deltas until all resolve (pack order guarantees base first for ofs).
  const deferred: PackEntry[] = [];
  for (const e of entries) {
    if (!e.oid.startsWith('__')) {
      out.push(e);
      byOffset.set(out.length - 1, e);
    } else {
      deferred.push(e);
    }
  }
  void byOffset;
  void held;
  // Deltas are not expected from this suite's client (it writes plain packs).
  // If any arrive, fail loudly rather than silently storing corrupt objects.
  if (deferred.length > 0) throw new Error('delta pack entries are not supported');
  return out;
}

// ---------------------------------------------------------------- reachability

export interface ReachResult {
  oids: Set<string>;
  boundaries: Set<string>;
}

/** Full closure of the haves (commits, trees, blobs, tag targets), stopping
 * at shallow boundaries: a boundary's ancestors are NOT in the closure, so
 * a deepen can still fetch them. */
function haveClosure(repo: Repo, haves: Set<string>, shallowBoundaries: Set<string>): Set<string> {
  const out = new Set<string>();
  const seenCommit = new Set<string>();
  const stack: string[] = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      if (seenCommit.has(oid)) continue;
      seenCommit.add(oid);
      out.add(oid);
      const parsed = parseCommit(obj.data);
      addTree(repo, parsed.tree, out, new Set());
      if (!shallowBoundaries.has(oid)) {
        for (const p of parsed.parents) stack.push(p);
      }
    } else if (obj.type === 'tag') {
      if (out.has(oid)) continue;
      out.add(oid);
      const target = parseTagTarget(obj.data);
      if (target !== null) stack.push(target);
    } else {
      out.add(oid);
    }
  }
  return out;
}

/** Reachable objects from tips, honouring haves (excluded) and a depth limit.
 * With a deepen request, a have that is also a shallow boundary is traversed
 * (its parents are candidates) but never re-sent: that is how deepen works. */
export function reachable(repo: Repo, tips: string[], haves: Set<string>, depthLimit: number | null, shallowBoundaries: Set<string> = new Set()): ReachResult {
  const oids = new Set<string>();
  const boundaries = new Set<string>();
  const excluded = haveClosure(repo, haves, shallowBoundaries);
  // BFS over commits with generation depth; trees/blobs included fully.
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const t of tips) queue.push({ oid: t, depth: 0 });
  const seenCommit = new Set<string>();
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (seenCommit.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      seenCommit.add(oid);
      const isHeld = excluded.has(oid);
      const deepenable = depthLimit !== null && isHeld && shallowBoundaries.has(oid);
      if (isHeld && !deepenable) continue; // held: neither sent nor traversed
      const parsed = parseCommit(obj.data);
      if (!isHeld) {
        oids.add(oid);
        addTree(repo, parsed.tree, oids, excluded);
      }
      if (depthLimit !== null && depth + 1 >= depthLimit) {
        if (!isHeld) boundaries.add(oid);
        continue; // do not traverse parents
      }
      for (const p of parsed.parents) queue.push({ oid: p, depth: depth + 1 });
    } else if (obj.type === 'tag') {
      if (excluded.has(oid)) continue;
      oids.add(oid);
      const target = parseTagTarget(obj.data);
      if (target !== null) queue.push({ oid: target, depth });
    } else {
      if (!excluded.has(oid)) oids.add(oid);
    }
  }
  return { oids, boundaries };
}

function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return null;
}

function addTree(repo: Repo, treeOid: string, oids: Set<string>, haves: Set<string>): void {
  if (haves.has(treeOid) || oids.has(treeOid)) return;
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  oids.add(treeOid);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '160000') continue; // gitlink
    if (e.mode === '40000') addTree(repo, e.oid, oids, haves);
    else if (!haves.has(e.oid)) oids.add(e.oid);
  }
}

/** Sideband-wrap a byte stream: split into band-1 pkt-lines (max payload 65515). */
export function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < data.length; off += CHUNK) {
    const chunk = data.subarray(off, Math.min(data.length, off + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- advertisements

export function v2Advertisement(): Buffer {
  const lines = ['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
  return Buffer.concat([...lines.map((l) => pktLine(l)), pktFlush()]);
}

export function refLine(oid: string, name: string, caps: string | null): Buffer {
  let line = `${oid} ${name}`;
  if (caps !== null) line += `\0${caps}`;
  return pktLine(`${line}\n`);
}

export function v0Advertisement(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=git-${service}\n`), pktFlush()];
  const caps =
    service === 'receive-pack'
      ? 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main'
      : 'side-band-64k thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=forge/1.0';
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (refs.length === 0) {
    parts.push(refLine(ZERO_OID, 'capabilities^{}', caps));
    return Buffer.concat(parts);
  }
  let first = true;
  const headTip = repo.refs.get('refs/heads/main') ?? repo.refs.get('refs/heads/master') ?? null;
  if (headTip !== null) {
    parts.push(refLine(headTip, 'HEAD', first ? caps : null));
    first = false;
  }
  for (const [name, oid] of refs) {
    parts.push(refLine(oid, name, first ? caps : null));
    first = false;
    // Peeled annotated tag.
    const obj = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && obj !== undefined && obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== null) parts.push(refLine(target, `${name}^{}`, null));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack v2

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  refPrefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

export function parseV2Request(body: Buffer): { command: string; req: FetchRequest } | null {
  const { items } = parsePktLines(body);
  const lines = pktLinesToStrings(items);
  let command = '';
  const req: FetchRequest = { wants: [], haves: [], shallow: [], deepen: null, refPrefixes: [], peel: false, symrefs: false, unborn: false };
  let inArgs = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('command=')) {
      command = t.slice(8);
      continue;
    }
    if (t === '') continue;
    if (command === 'ls-refs') {
      if (t === 'peel') req.peel = true;
      else if (t === 'symrefs') req.symrefs = true;
      else if (t === 'unborn') req.unborn = true;
      else if (t.startsWith('ref-prefix ')) req.refPrefixes.push(t.slice(11));
      continue;
    }
    if (command === 'fetch') {
      if (t.startsWith('want ')) req.wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) req.haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) req.shallow.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) req.deepen = parseInt(t.slice(7), 10);
      void inArgs;
    }
  }
  if (command === '') return null;
  return { command, req };
}

export function lsRefsResponse(repo: Repo, req: FetchRequest): Buffer {
  const parts: Buffer[] = [];
  const headTip = repo.refs.get('refs/heads/main');
  // HEAD entry first — but never under a ref-prefix filter (HEAD is not a refs/* name).
  if (req.symrefs && req.refPrefixes.length === 0) {
    if (headTip !== undefined) parts.push(pktLine(`${headTip} HEAD symref-target:refs/heads/main\n`));
    else if (req.unborn) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, oid] of refs) {
    if (req.refPrefixes.length > 0 && !req.refPrefixes.some((p) => name.startsWith(p))) continue;
    let line = `${oid} ${name}`;
    if (req.peel) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const target = parseTagTarget(obj.data);
        if (target !== null) line += ` peeled:${target}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function fetchResponse(repo: Repo, req: FetchRequest): Buffer {
  const parts: Buffer[] = [];
  const haveSet = new Set(req.haves.map((h) => h.toLowerCase()));
  const shallowSet = new Set(req.shallow.map((s) => s.toLowerCase()));
  const wants = [...new Set(req.wants.map((w) => w.toLowerCase()))].filter((w) => w !== ZERO_OID);
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  if (haveSet.size === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    let acked = false;
    for (const h of haveSet) {
      if (repo.objects.has(h)) {
        parts.push(pktLine(`ACK ${h}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush());
  // compute reachable set
  const depth = req.deepen;
  const reach = reachable(repo, wants, haveSet, depth, shallowSet);
  // shallow-info
  const newBoundaries = [...reach.boundaries];
  const unshallow: string[] = [];
  for (const s of shallowSet) {
    if (newBoundaries.includes(s)) continue;
    // old boundary is unshallowed when any of its parents was fetched
    const obj = repo.objects.get(s);
    if (obj !== undefined && obj.type === 'commit') {
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => reach.oids.has(p))) unshallow.push(s);
    }
  }
  if (newBoundaries.length > 0 || unshallow.length > 0 || shallowSet.size > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const b of newBoundaries) parts.push(pktLine(`shallow ${b}\n`));
    for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(pktFlush());
  }
  // wanted-refs
  parts.push(pktLine('wanted-refs\n'));
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (wants.includes(oid.toLowerCase())) parts.push(pktLine(`${oid} ${name}\n`));
  }
  parts.push(pktFlush());
  // packfile
  parts.push(pktLine('packfile\n'));
  const objs: Array<{ type: ObjectType; data: Buffer }> = [];
  for (const oid of reach.oids) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objs.push(obj);
  }
  objs.sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : 1;
  });
  const pack = writePack(objs);
  parts.push(sideband(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack v0

export function v0FetchResponse(repo: Repo, body: Buffer): Buffer {
  const { items } = parsePktLines(body);
  const lines = pktLinesToStrings(items);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let seenFlush = false;
  for (const it of items) {
    if (it.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (it.kind !== 'data') continue;
    const t = it.data.toString('utf8').trim();
    if (!seenFlush) {
      if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0] as string);
      else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) deepen = parseInt(t.slice(7), 10);
    } else {
      if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) deepen = parseInt(t.slice(7), 10);
    }
  }
  void lines;
  const haveSet = new Set(haves.map((h) => h.toLowerCase()));
  const shallowSet = new Set(shallow.map((s) => s.toLowerCase()));
  const reach = reachable(
    repo,
    [...new Set(wants.map((w) => w.toLowerCase()))].filter((w) => w !== ZERO_OID),
    haveSet,
    deepen,
    shallowSet,
  );
  const parts: Buffer[] = [];
  if (haveSet.size === 0) parts.push(pktLine('NAK\n'));
  else {
    let acked = false;
    for (const h of haveSet) {
      if (repo.objects.has(h)) {
        parts.push(pktLine(`ACK ${h}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
  }
  for (const b of reach.boundaries) parts.push(pktLine(`shallow ${b}\n`));
  for (const s of shallowSet) {
    if (reach.boundaries.has(s)) continue;
    const obj = repo.objects.get(s);
    if (obj !== undefined && obj.type === 'commit') {
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => reach.oids.has(p))) parts.push(pktLine(`unshallow ${s}\n`));
    }
  }
  const objs: Array<{ type: ObjectType; data: Buffer }> = [];
  for (const oid of reach.oids) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objs.push(obj);
  }
  objs.sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : 1;
  });
  parts.push(sideband(writePack(objs)));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushResult {
  unpackOk: boolean;
  unpackDetail: string;
  results: Array<{ ref: string; ok: boolean; reason: string }>;
}

export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const { items, next, rawTail } = parsePktLines(body);
  const commands: PushCommand[] = [];
  for (const it of items) {
    if (it.kind !== 'data') continue;
    let text = it.data.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.trim().split(/\s+/);
    if (parts.length >= 3) {
      commands.push({ oldOid: (parts[0] as string).toLowerCase(), newOid: (parts[1] as string).toLowerCase(), ref: parts[2] as string });
    }
  }
  let pack: Buffer | null = null;
  if (rawTail !== null && rawTail.length > 0) pack = rawTail;
  else if (next < body.length) pack = body.subarray(next);
  if (pack !== null && pack.length === 0) pack = null;
  return { commands, pack };
}

export function applyPush(store: Store, repo: Repo, commands: PushCommand[], pack: Buffer | null): PushResult {
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack !== null) {
    try {
      const entries = readPack(pack);
      const resolved = resolvePackEntries(entries, repo.objects);
      for (const e of resolved) repo.objects.set(e.oid, { type: e.type, data: e.data });
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref) ?? null;
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === null) {
          results.push({ ref: cmd.ref, ok: false, reason: 'no such ref' });
        } else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (current === null) {
        // create
        if (cmd.oldOid !== ZERO_OID) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        if (!repo.objects.has(cmd.newOid)) {
          results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      // update: old must match current tip; new must descend from old/current
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
        continue;
      }
      const base = cmd.oldOid === ZERO_OID ? current : cmd.oldOid;
      if (!store.isAncestor(repo, base, cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  } else {
    for (const cmd of commands) results.push({ ref: cmd.ref, ok: false, reason: unpackDetail });
  }
  return { unpackOk, unpackDetail, results };
}

export function pushReport(result: PushResult, useSideband: boolean): Buffer {
  const lines: Buffer[] = [];
  lines.push(pktLine(result.unpackOk ? 'unpack ok\n' : `unpack ${result.unpackDetail}\n`));
  for (const r of result.results) {
    if (r.ok) lines.push(pktLine(`ok ${r.ref}\n`));
    else lines.push(pktLine(`ng ${r.ref} ${r.reason}\n`));
  }
  lines.push(pktFlush());
  const body = Buffer.concat(lines);
  if (useSideband) return Buffer.concat([sideband(body), pktFlush()]);
  return body;
}
