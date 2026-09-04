// PNG 工作流元数据解包器(md「二进制流式 PNG Chunk 元数据解包器」):
// 纯内存字节流扫描 tEXt/iTXt 块,提取 ComfyUI 嵌入的 workflow/prompt JSON,
// 无需图像解码库。iTXt 压缩载荷用平台 DecompressionStream('deflate') 解压。
// 纯逻辑无 DOM 依赖(DecompressionStream 在 Node ≥17 与 Electron 渲染端均可用)。

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(u8) {
  return u8 && u8.length >= 8 && PNG_SIG.every((b, i) => u8[i] === b);
}

// 逐块扫描:4 字节大端 Length + 4 字节 Type + Data + 4 字节 CRC32
export function* scanChunks(u8) {
  if (!isPng(u8)) return;
  let cursor = 8;
  while (cursor + 12 <= u8.length) {
    const length = (u8[cursor] << 24 | u8[cursor + 1] << 16 | u8[cursor + 2] << 8 | u8[cursor + 3]) >>> 0;
    const type = String.fromCharCode(u8[cursor + 4], u8[cursor + 5], u8[cursor + 6], u8[cursor + 7]);
    const data = u8.subarray(cursor + 8, cursor + 8 + length);
    if (cursor + 8 + length + 4 > u8.length) return; // 截断文件,放弃
    yield { type, data };
    if (type === 'IEND') return;
    cursor += 12 + length;
  }
}

// tEXt: Keyword + \0 + TextValue(Latin-1;ComfyUI 写入的 workflow/prompt 均为 ASCII/JSON)
function parseTextChunk(data) {
  const nul = data.indexOf(0);
  if (nul < 0) return null;
  return {
    keyword: latin1(data.subarray(0, nul)),
    text: latin1(data.subarray(nul + 1)),
  };
}

// iTXt: Keyword \0 CompressionFlag \0 CompressionMethod \0 Lang \0 Translated \0 Text(UTF-8,可 zlib 压缩)
async function parseItxtChunk(data) {
  let p = data.indexOf(0);
  if (p < 0) return null;
  const keyword = latin1(data.subarray(0, p));
  const flag = data[p + 1];
  // p+2 = compression method(0=zlib deflate);其后是 language\0 translated\0 text
  let q = data.indexOf(0, p + 3);
  if (q < 0) return null;
  q = data.indexOf(0, q + 1);
  if (q < 0) return null;
  const payload = data.subarray(q + 1);
  const bytes = flag === 1 ? await inflate(payload) : payload;
  return { keyword, text: utf8(bytes) };
}

async function inflate(u8) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([u8]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// 提取工作流元数据。返回 { workflow?, prompt? }(workflow=界面格式,prompt=API 执行格式),
// 找不到返回 null。调用方再交给 comfy:format 的 importAny 做格式识别。
export async function extractWorkflowMeta(u8) {
  if (!isPng(u8)) return null;
  const meta = {};
  for (const chunk of scanChunks(u8)) {
    let parsed = null;
    try {
      if (chunk.type === 'tEXt') parsed = parseTextChunk(chunk.data);
      else if (chunk.type === 'iTXt') parsed = await parseItxtChunk(chunk.data);
    } catch { continue; } // 单块损坏不拖垮整体
    if (!parsed) continue;
    if (parsed.keyword === 'workflow' && !meta.workflow) meta.workflow = parsed.text;
    if (parsed.keyword === 'prompt' && !meta.prompt) meta.prompt = parsed.text;
    if (meta.workflow && meta.prompt) break;
  }
  return (meta.workflow || meta.prompt) ? meta : null;
}

function latin1(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

function utf8(u8) {
  return new TextDecoder('utf-8').decode(u8);
}
