/* ============================================================
 * dpi.js — 导出图片物理分辨率（DPI）注入
 * PNG : 插入/替换 pHYs 块（像素/米）
 * JPEG: 写入/修补 JFIF APP0 密度字段
 * 纯字节操作，无依赖。
 * ============================================================ */
'use strict';

window.DpiUtil = (function () {

  /* ---------- CRC32 (PNG chunk 用) ---------- */
  var crcTable = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes, start, length) {
    var c = 0xFFFFFFFF;
    for (var i = start; i < start + length; i++) {
      c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------- PNG pHYs ---------- */
  function setPngDpi(arrayBuffer, dpi) {
    var ppm = Math.round(dpi / 0.0254); // 像素/米
    var src = new Uint8Array(arrayBuffer);

    // PNG 签名校验
    if (!(src[0] === 0x89 && src[1] === 0x50 && src[2] === 0x4E && src[3] === 0x47)) {
      return arrayBuffer; // 不是 PNG，原样返回
    }

    // 遍历 chunk：找到 IHDR 结束位置与所有已存在的 pHYs（非常规文件可能多处出现）
    var pos = 8;
    var insertPos = -1;   // 插入点（IHDR 块之后）
    var physRanges = [];  // 所有旧 pHYs [start, end)
    while (pos + 8 <= src.length) {
      var len = (src[pos] << 24) | (src[pos + 1] << 16) | (src[pos + 2] << 8) | src[pos + 3];
      var type = String.fromCharCode(src[pos + 4], src[pos + 5], src[pos + 6], src[pos + 7]);
      var end = pos + 12 + len;
      if (type === 'IHDR') insertPos = end;
      if (type === 'pHYs') physRanges.push([pos, end]);
      if (type === 'IEND') break;
      pos = end;
    }
    if (insertPos < 0) return arrayBuffer;

    // 构造 pHYs 块
    var chunk = new Uint8Array(21); // 4 len + 4 type + 9 data + 4 crc
    var dv = new DataView(chunk.buffer);
    dv.setUint32(0, 9);
    chunk[4] = 0x70; chunk[5] = 0x48; chunk[6] = 0x59; chunk[7] = 0x73; // "pHYs"
    dv.setUint32(8, ppm);
    dv.setUint32(12, ppm);
    chunk[16] = 1; // 单位：米
    var crc = crc32(chunk, 4, 13);
    dv.setUint32(17, crc);

    // 移除全部旧 pHYs（保证输出仅含单个 pHYs，符合规范单块约束），
    // 新块统一插到 IHDR 之后
    var totalRemove = physRanges.reduce(function (s, rg) { return s + (rg[1] - rg[0]); }, 0);
    var out = new Uint8Array(src.length - totalRemove + 21);
    var wi = 0, ri = 0;
    for (var seg = 0; seg <= physRanges.length; seg++) {
      var segEnd = seg < physRanges.length ? physRanges[seg][0] : src.length;
      if (insertPos >= ri && insertPos <= segEnd) {
        // 插入点落在当前区间：先拷到插入点，写新块，再拷余下部分
        out.set(src.subarray(ri, insertPos), wi); wi += insertPos - ri;
        out.set(chunk, wi); wi += 21;
        out.set(src.subarray(insertPos, segEnd), wi); wi += segEnd - insertPos;
      } else {
        out.set(src.subarray(ri, segEnd), wi); wi += segEnd - ri;
      }
      if (seg < physRanges.length) ri = physRanges[seg][1];
    }
    return out.buffer;
  }

  /* ---------- JPEG JFIF APP0 ---------- */
  function setJpegDpi(arrayBuffer, dpi) {
    var src = new Uint8Array(arrayBuffer);
    // JPEG 签名 FFD8
    if (!(src[0] === 0xFF && src[1] === 0xD8)) return arrayBuffer;

    var x = Math.round(dpi), y = Math.round(dpi);

    // 已有 JFIF APP0：直接修补（布局: FF E0 len(2) "JFIF\0"(5) ver(2) units(1) X(2) Y(2) thumb(2)）
    if (src[2] === 0xFF && src[3] === 0xE0 &&
        src[6] === 0x4A && src[7] === 0x46 && src[8] === 0x49 && src[9] === 0x46 && src[10] === 0x00) {
      var out = new Uint8Array(src);
      out[13] = 1;            // 单位：英寸
      out[14] = (x >> 8) & 0xFF;
      out[15] = x & 0xFF;
      out[16] = (y >> 8) & 0xFF;
      out[17] = y & 0xFF;
      return out.buffer;
    }

    // 无 APP0：在 SOI 后插入
    var app0 = new Uint8Array(18);
    app0[0] = 0xFF; app0[1] = 0xE0;
    app0[2] = 0x00; app0[3] = 0x10;        // 长度 16
    app0[4] = 0x4A; app0[5] = 0x46; app0[6] = 0x49; app0[7] = 0x46; app0[8] = 0x00; // "JFIF\0"
    app0[9] = 0x01; app0[10] = 0x01;       // 版本 1.1
    app0[11] = 1;                          // 单位：英寸
    app0[12] = (x >> 8) & 0xFF; app0[13] = x & 0xFF;
    app0[14] = (y >> 8) & 0xFF; app0[15] = y & 0xFF;
    app0[16] = 0x00; app0[17] = 0x00;      // 无缩略图

    var out2 = new Uint8Array(src.length + 18);
    out2.set(src.subarray(0, 2), 0);
    out2.set(app0, 2);
    out2.set(src.subarray(2), 20);
    return out2.buffer;
  }

  return { setPngDpi: setPngDpi, setJpegDpi: setJpegDpi };
})();
