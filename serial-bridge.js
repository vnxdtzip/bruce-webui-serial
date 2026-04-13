/* serial-bridge.js – pure Web Serial API bridge for Bruce WebUI
 * No Python/Flask required — open index.html directly in Chrome/Edge/Opera.
 * Loaded after index.js; overrides its HTTP-based helper functions.
 *
 * Key fixes vs naïve implementation:
 *  - _lineAccum: string buffer that spans chunk boundaries so lines are
 *    never split into corrupt fragments (was the root cause of incomplete
 *    file listings and wrong storage values).
 *  - Storage parser is case-insensitive and comma-aware.
 *  - _commitText(isPrompt) cleanly separates prompt-flushes from partial
 *    end-of-chunk flushes.
 */

// ── Constants (mirrored from Bruce's tftLogger.h) ─────────────────────
const LOG_PACKET_HEADER = 0xAA;
const SCREEN_INFO_FN    = 99;   // 0x63
const FILLSCREEN_FN     = 0;

// ── Utility ───────────────────────────────────────────────────────────
function humanSize(b) {
  if (b < 1024)       return b + " B";
  if (b < 1048576)    return (b / 1024).toFixed(1) + " kB";
  if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
  return (b / 1073741824).toFixed(1) + " GB";
}

// ── BruceSerial ───────────────────────────────────────────────────────
class BruceSerial {
  constructor() {
    this.port      = null;
    this.connected = false;
    this.portLabel = "";

    // ── command-queue state ──────────────────────────────────────────
    this._cmdInFlight = false;   // lock: one command at a time
    this._cmdResolve  = null;    // resolve fn of the in-flight promise
    this._cmdTimer    = null;    // timeout handle
    this._respLines   = [];      // completed response lines
    this._waiting     = false;   // true while expecting a "# " prompt

    // ── TFT screen buffer ────────────────────────────────────────────
    this._scrInfo = null;        // latest SCREEN_INFO packet (Uint8Array)
    this._scrPkts = [];          // draw packets (Uint8Array[])

    // ── serial parser state machine ──────────────────────────────────
    this._PS_IDLE    = 0;
    this._PS_GOT_HDR = 1;
    this._PS_IN_PKT  = 2;
    this._ps   = this._PS_IDLE;
    this._bin  = [];             // bytes accumulating for current binary pkt
    this._brem = 0;              // bytes remaining in current binary pkt
    this._txt  = [];             // raw bytes of current text burst

    // ── cross-chunk line accumulator (THE critical fix) ──────────────
    // Stores the incomplete tail of the last chunk so that lines split
    // across chunk boundaries are never broken into corrupt fragments.
    this._lineAccum = "";
  }

  // ════════════════════════════════════════════════════════════════════
  //  Public API
  // ════════════════════════════════════════════════════════════════════

  /** Open port via browser's native serial picker. */
  async connect(baud = 115200) {
    if (this.connected) await this.disconnect();
    this.port = await navigator.serial.requestPort();
    await this.port.open({
      baudRate: baud, dataBits: 8, stopBits: 1,
      parity: "none", flowControl: "none",
    });
    this.connected = true;
    this.portLabel = baud + " baud";
    this._resetParser();
    this._startReader();          // background loop, fire-and-forget

    await this._delay(300);
    await this.sendCmd("display start", 3000);
    await this._delay(200);
    await this.sendCmd("nav up",   3000);
    await this.sendCmd("nav down", 3000);
  }

  async disconnect() {
    this.connected = false;
    this._finishCmd("");          // cancel any in-flight command
    if (this.port) {
      try { await this.port.close(); } catch (_) {}
      this.port = null;
    }
  }

  /**
   * Send a line, wait for the "# " prompt, return response text.
   * Commands are serialised: a second call blocks until the first resolves.
   */
  async sendCmd(cmd, timeout = 6000) {
    if (!this.connected) return "";
    while (this._cmdInFlight) await this._delay(20);

    this._cmdInFlight = true;
    this._respLines   = [];
    this._lineAccum   = "";       // fresh accumulator for this command
    this._waiting     = true;

    await this._writeRaw(new TextEncoder().encode(cmd.trim() + "\n"));

    return new Promise((resolve) => {
      this._cmdResolve = resolve;
      this._cmdTimer   = setTimeout(() => {
        // Timeout: return whatever we have so far
        this._finishCmd(this._respLines.join("\n"));
      }, timeout);
    });
  }

  /** Fire-and-forget raw write (reboot, display-stop, etc.). */
  async sendRaw(data) { await this._writeRaw(data); }

  /** Assemble binary blob identical to /getscreen on the real device. */
  getScreenBinary() {
    const parts = this._scrInfo
      ? [this._scrInfo, ...this._scrPkts]
      : [...this._scrPkts];
    if (!parts.length) {
      // Minimal SCREEN_INFO for 240×135, rotation 0
      return new Uint8Array([0xAA, 0x08, 0x63, 0x00, 0xF0, 0x00, 0x87, 0x00]);
    }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out   = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  // ════════════════════════════════════════════════════════════════════
  //  File / filesystem operations
  // ════════════════════════════════════════════════════════════════════

  async listFiles(path) {
    path = (path || "/").replace(/^([^/])/, "/$1");
    const raw   = await this.sendCmd("ls " + path, 8000);
    const lines = [`pa:${path}:0`];
    for (const line of raw.split("\n")) {
      const t   = line.trim();
      if (!t) continue;
      const tab = t.indexOf("\t");
      if (tab < 0) continue;
      const name = t.slice(0, tab).trim();
      const info = t.slice(tab + 1).trim();
      if (!name) continue;
      const size = parseInt(info);
      lines.push(info === "<DIR>"
        ? `Fo:${name}:0`
        : `Fi:${name}:${isNaN(size) ? "0 B" : humanSize(size)}`);
    }
    return lines.join("\n");
  }

  async readFile(path) {
    if (!path.startsWith("/")) path = "/" + path;
    return await this.sendCmd("cat " + path, 12000);
  }

  async writeFile(path, content) {
    if (!path.startsWith("/")) path = "/" + path;
    const size = Math.max(content.length + 512, 1024);
    const enc  = new TextEncoder();
    await this._writeRaw(enc.encode(`storage write ${path} ${size}\n`));
    await this._delay(400);
    for (const line of content.split("\n")) {
      await this._writeRaw(enc.encode(line + "\n"));
      await this._delay(5);
    }
    await this._writeRaw(enc.encode("EOF\n"));
    await this._delay(800);
  }

  async deletePath(path) {
    if (!path.startsWith("/")) path = "/" + path;
    let r = await this.sendCmd("rm " + path, 5000);
    if (!r || /error|not.exist/i.test(r))
      r = await this.sendCmd("rmdir " + path, 5000);
    return r || "Done";
  }

  async createDir(path) {
    if (!path.startsWith("/")) path = "/" + path;
    return await this.sendCmd("mkdir " + path, 4000);
  }

  async createFile(path) {
    if (!path.startsWith("/")) path = "/" + path;
    await this.writeFile(path, "");
    return "Created: " + path;
  }

  async renamePath(oldP, newP) {
    if (!oldP.startsWith("/")) oldP = "/" + oldP;
    if (!newP.startsWith("/")) newP = "/" + newP;
    return await this.sendCmd(`storage rename ${oldP} ${newP}`, 5000);
  }

  async storageInfo() {
    const MAX = 128 * 1024 * 1024;

    // Parse output of "storage free sd/littlefs".
    // Flexible: handles "1234 Bytes", "1234 bytes", "1,234,567 Bytes".
    const parse = (text) => {
      const r = {};
      for (const line of text.split("\n")) {
        const m = line.match(/(\d[\d,]*)\s+[Bb]ytes/);
        if (!m) continue;
        const v = parseInt(m[1].replace(/,/g, ""), 10);
        if (isNaN(v) || v < 0 || v > MAX) continue;
        const lo = line.toLowerCase();
        if      (lo.includes("total")) r.total = v;
        else if (lo.includes("used"))  r.used  = v;
        else if (lo.includes("free"))  r.free  = v;
      }
      return r;
    };

    let version = "serial";
    const infoText = await this.sendCmd("info", 5000);
    for (const line of infoText.split("\n"))
      if (line.startsWith("Bruce ")) { version = line.trim(); break; }

    const sdText  = await this.sendCmd("storage free sd",       5000);
    const lfsText = await this.sendCmd("storage free littlefs", 5000);

    const sd  = parse(sdText);
    const lfs = parse(lfsText);

    // Show "N/A" when the filesystem appears absent (total = 0 or not parsed)
    const fmtLfs = (k) => lfs[k]  ? humanSize(lfs[k])  : "N/A";
    const fmtSd  = (k) => sd[k]   ? humanSize(sd[k])   : "0 B";

    return {
      BRUCE_VERSION: version,
      SD:       { free: fmtSd("free"),  used: fmtSd("used"),  total: fmtSd("total")  },
      LittleFS: { free: fmtLfs("free"), used: fmtLfs("used"), total: fmtLfs("total") },
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  Private – parser
  // ════════════════════════════════════════════════════════════════════

  _resetParser() {
    this._ps = this._PS_IDLE;
    this._bin = []; this._brem = 0; this._txt = [];
    this._lineAccum = "";
    this._scrInfo = null; this._scrPkts = [];
  }

  _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async _writeRaw(data) {
    if (!this.port?.writable) return;
    const w = this.port.writable.getWriter();
    try { await w.write(data); } finally { w.releaseLock(); }
  }

  async _startReader() {
    while (this.connected && this.port?.readable) {
      const reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) this._parseChunk(value);
        }
      } catch (e) {
        if (this.connected) console.error("[BruceSerial] read error:", e);
      } finally {
        try { reader.releaseLock(); } catch (_) {}
      }
    }
  }

  /**
   * Feed a raw Uint8Array from the serial port into the state machine.
   *
   * Binary packets (0xAA header) are routed to the TFT screen buffer.
   * Everything else is text, routed to _lineAccum → _respLines.
   *
   * IMPORTANT: _txt is only decoded+committed at two moments:
   *   1. When 0xAA is seen (switch to binary) – partial flush
   *   2. When "# " (0x23 0x20) is detected at the tail of _txt – prompt flush
   *   3. At the end of the chunk if bytes remain – partial flush
   *
   * After decoding, text is appended to _lineAccum. Only full lines
   * (terminated by \n) are extracted and added to _respLines. The
   * incomplete tail stays in _lineAccum until the next chunk provides
   * the rest of the line. This prevents corrupt line fragments.
   */
  _parseChunk(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];

      if (this._ps === this._PS_IDLE) {
        if (b === LOG_PACKET_HEADER) {
          // Binary packet starting – flush text accumulated so far
          if (this._txt.length) this._commitText(false);
          this._bin = [b];
          this._ps  = this._PS_GOT_HDR;

        } else {
          this._txt.push(b);
          // Detect "# " prompt as the last two bytes in _txt
          const n = this._txt.length;
          if (n >= 2 &&
              this._txt[n - 2] === 0x23 &&   // '#'
              this._txt[n - 1] === 0x20) {    // ' '
            this._commitText(true);           // isPrompt = true → finish command
          }
        }

      } else if (this._ps === this._PS_GOT_HDR) {
        this._bin.push(b);
        this._brem = b - 2;
        if (this._brem <= 0) { this._commitBin(); this._ps = this._PS_IDLE; }
        else                   this._ps = this._PS_IN_PKT;

      } else {  // _PS_IN_PKT
        this._bin.push(b);
        if (--this._brem <= 0) { this._commitBin(); this._ps = this._PS_IDLE; }
      }
    }

    // End of chunk: flush any remaining text bytes (partial – no prompt yet)
    if (this._txt.length && this._ps === this._PS_IDLE) {
      this._commitText(false);
    }
  }

  /**
   * Decode accumulated _txt bytes, append to _lineAccum, and:
   *   isPrompt = true  → process ALL content, finish the command
   *   isPrompt = false → process only complete lines (\n-terminated),
   *                      keep the trailing fragment in _lineAccum
   *
   * This is the key method that eliminates partial-line corruption.
   */
  _commitText(isPrompt) {
    const text = new TextDecoder().decode(new Uint8Array(this._txt));
    this._txt  = [];

    if (!this._waiting) return;

    this._lineAccum += text;

    if (isPrompt) {
      // We have the full response; process everything and resolve.
      const content   = this._lineAccum;
      this._lineAccum = "";
      this._processLines(content);
      this._finishCmd(this._respLines.join("\n"));

    } else {
      // Partial flush: commit only lines that end with \n.
      // Keep the incomplete tail for the next chunk.
      const cut = this._lineAccum.lastIndexOf("\n");
      if (cut >= 0) {
        const complete  = this._lineAccum.slice(0, cut);
        this._lineAccum = this._lineAccum.slice(cut + 1);
        this._processLines(complete);
      }

      // Edge-case: prompt arrives in two chunks (rare but possible).
      // Detect "# " or a bare "#" already sitting in _lineAccum.
      if (this._lineAccum.includes("# ") ||
          this._lineAccum.trimEnd() === "#") {
        const content   = this._lineAccum;
        this._lineAccum = "";
        this._processLines(content);
        this._finishCmd(this._respLines.join("\n"));
      }
    }
  }

  /** Filter and append completed lines to _respLines. */
  _processLines(text) {
    for (const line of text.split("\n")) {
      const clean = line.replace(/\r$/, "");
      if (clean.startsWith("COMMAND:"))    continue;  // command echo
      if (/^#?\s*$/.test(clean.trim()))    continue;  // empty / bare "#"
      this._respLines.push(clean);
    }
  }

  _commitBin() {
    const raw = new Uint8Array(this._bin);
    this._bin = [];
    if (raw.length < 3) return;
    const fn = raw[2];
    if      (fn === SCREEN_INFO_FN) { this._scrInfo = raw; }
    else if (fn === FILLSCREEN_FN)  { this._scrPkts = [raw]; }
    else {
      if (this._scrPkts.length >= 512) this._scrPkts.shift();
      this._scrPkts.push(raw);
    }
  }

  _finishCmd(result) {
    if (this._cmdTimer) { clearTimeout(this._cmdTimer); this._cmdTimer = null; }
    this._waiting     = false;
    this._cmdInFlight = false;
    this._lineAccum   = "";
    const cb = this._cmdResolve;
    this._cmdResolve  = null;
    if (cb) cb(result ?? "");
  }
}

// ── Global singleton ──────────────────────────────────────────────────
const bruceSerial = new BruceSerial();

// ════════════════════════════════════════════════════════════════════════
//  HTTP override layer
//  index.js makes HTTP calls to /systeminfo, /listfiles, /file, /cm …
//  We intercept them here and route to bruceSerial instead.
// ════════════════════════════════════════════════════════════════════════

// ── requestGet ────────────────────────────────────────────────────────
window.requestGet = async function (url, data) {
  if (!bruceSerial.connected) throw new Error("Not connected");

  let full = url;
  if (data) full += "?" + new URLSearchParams(data).toString();

  const qi  = full.indexOf("?");
  const pth = (qi >= 0 ? full.slice(0, qi) : full).replace(/^\/bruce/, "");
  const qs  = qi >= 0 ? new URLSearchParams(full.slice(qi + 1)) : new URLSearchParams();

  switch (pth) {
    case "/systeminfo": return JSON.stringify(await bruceSerial.storageInfo());
    case "/listfiles":  return await bruceSerial.listFiles(qs.get("folder") || "/");
    case "/file": {
      const name = qs.get("name") || "";
      switch (qs.get("action") || "") {
        case "edit":       return await bruceSerial.readFile(name);
        case "download":   return await bruceSerial.readFile(name);
        case "delete":     return await bruceSerial.deletePath(name);
        case "create":     return await bruceSerial.createDir(name);
        case "createfile": return await bruceSerial.createFile(name);
        case "image":      return "";   // images can't load without a server
      }
      break;
    }
    case "/reboot":
      await bruceSerial.sendRaw(new TextEncoder().encode("reboot\n"));
      return "Rebooting…";
  }
  throw new Error("requestGet: unknown endpoint " + pth);
};

// ── requestPost ───────────────────────────────────────────────────────
window.requestPost = async function (url, data) {
  if (!bruceSerial.connected) throw new Error("Not connected");
  const pth = url.split("?")[0].replace(/^\/bruce/, "");

  switch (pth) {
    case "/cm":
      return await bruceSerial.sendCmd(data.cmnd || "", 6000);
    case "/edit":
      await bruceSerial.writeFile(data.name || "", data.content || "");
      return "File edited: " + data.name;
    case "/rename": {
      const fp     = data.filePath || "";
      const parent = fp.lastIndexOf("/") > 0
        ? fp.slice(0, fp.lastIndexOf("/")) : "/";
      const newP   = (parent + "/" + data.fileName).replace(/\/\//g, "/");
      return await bruceSerial.renamePath(fp, newP);
    }
  }
  throw new Error("requestPost: unknown endpoint " + pth);
};

// ── fetch (serial terminal uses fetch("/cm"), navigator uses fetch("/getscreen")) ──
const _origFetch = window.fetch.bind(window);
window.fetch = async function (input, init) {
  const rawUrl = typeof input === "string" ? input : input.url;
  const url    = rawUrl.replace(/^\/bruce/, "");

  // Serial terminal command
  if (url === "/cm" || url.startsWith("/cm?")) {
    if (!bruceSerial.connected)
      return new Response("Not connected", { status: 503 });
    let cmd = "";
    if (init?.body) {
      const b = init.body;
      const s = typeof b === "string" ? b
              : b instanceof URLSearchParams ? b.toString()
              : new TextDecoder().decode(
                  b instanceof ArrayBuffer ? b
                  : await new Response(b).arrayBuffer()
                );
      cmd = new URLSearchParams(s).get("cmnd") || "";
    }
    return new Response(await bruceSerial.sendCmd(cmd, 6000), { status: 200 });
  }

  // TFT screen dump (used by navigator / screen mirror)
  if (url === "/getscreen" || url.startsWith("/getscreen?")) {
    const data = bruceSerial.connected
      ? bruceSerial.getScreenBinary()
      : new Uint8Array([0xAA, 0x08, 0x63, 0x00, 0xF0, 0x00, 0x87, 0x00]);
    return new Response(data.buffer, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  return _origFetch(input, init);
};

// ── uploadFile (replace XHR upload with serial write) ─────────────────
window.uploadFile = async function () {
  if (_queueUpload.length === 0) {
    _runningUpload = false;
    document.querySelector(".dialog.upload .dialog-body").innerHTML = "";
    try { await fetchSystemInfo(); } catch (_) {}
    try { fetchFiles(currentDrive, currentPath); } catch (_) {}
    Dialog.hide();
    return;
  }

  _runningUpload = true;
  const file     = _queueUpload.shift();
  const filename = file.webkitRelativePath || file.name;
  const fileId   = stringToId(filename);
  const bar      = document.getElementById(fileId);

  try {
    const content = await file.text();
    const path    = ((currentPath || "/").replace(/\/$/, "") + "/" + filename)
                      .replace(/\/\//g, "/");
    if (bar) bar.style.width = "50%";
    await bruceSerial.writeFile(path, content);
    if (bar) bar.style.width = "100%";
  } catch (e) {
    console.error("[uploadFile]", e);
  }

  window.uploadFile();  // process next item in queue
};

// ── Download link interceptor ─────────────────────────────────────────
// .act-download anchors have href="/file?…action=download" which won't
// work without a server. Intercept at capture phase and use serial read.
document.addEventListener("click", async (e) => {
  const dl   = e.target.closest(".act-download");
  if (!dl) return;
  const href = dl.getAttribute("href") || "";
  if (!href.includes("action=download")) return;

  e.preventDefault();
  e.stopPropagation();

  if (!bruceSerial.connected) { alert("Not connected"); return; }

  const p        = new URLSearchParams((href.split("?")[1]) || "");
  const name     = p.get("name") || "";
  const fileName = dl.getAttribute("download") || name.split("/").pop();

  Dialog.loading.show("Downloading " + fileName + "…");
  try {
    const content = await bruceSerial.readFile(name);
    const burl    = URL.createObjectURL(
                      new Blob([content], { type: "application/octet-stream" }));
    const a = Object.assign(document.createElement("a"),
                            { href: burl, download: fileName });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(burl); }, 100);
  } catch (err) {
    alert("Download failed: " + err.message);
  } finally {
    Dialog.loading.hide();
  }
}, true);   // capture phase → fires before anchor default navigation

// ── reloadScreen – strips DRAWIMAGE (fn=18) packets ───────────────────
// DRAWIMAGE tries to load image files via HTTP URL, which fails without
// a server. We filter them out before passing to renderTFT.
(function () {
  function stripDrawImage(data) {
    const out = [];
    let i = 0;
    while (i + 2 < data.length) {
      if (data[i] !== 0xAA) break;
      const size = data[i + 1];
      if (size < 3 || i + size > data.length) break;
      if (data[i + 2] !== 18) {           // keep everything except DRAWIMAGE
        for (let j = i; j < i + size; j++) out.push(data[j]);
      }
      i += size;
    }
    return new Uint8Array(out);
  }

  window.reloadScreen = async function () {
    if (window.SCREEN_RELOAD) return;
    window.SCREEN_RELOAD = true;
    const btn = document.getElementById("force-reload");
    if (btn) btn.classList.add("reloading");
    try {
      const raw = bruceSerial.connected
        ? bruceSerial.getScreenBinary()
        : new Uint8Array([0xAA, 0x08, 0x63, 0x00, 0xF0, 0x00, 0x87, 0x00]);
      await renderTFT(stripDrawImage(raw));
    } catch (e) {
      console.error("reloadScreen:", e);
    } finally {
      if (btn) btn.classList.remove("reloading");
      window.SCREEN_RELOAD = false;
    }
  };
})();

// ════════════════════════════════════════════════════════════════════════
//  Connection UI
// ════════════════════════════════════════════════════════════════════════

function _showConnectScreen() {
  document.getElementById("connect-screen").classList.remove("hidden");
  document.getElementById("serial-bar").classList.add("hidden");
}

function _showMainUI(label) {
  document.getElementById("connect-screen").classList.add("hidden");
  document.getElementById("serial-bar").classList.remove("hidden");
  document.getElementById("serial-bar-status").textContent = "● Connected  " + label;
}

/** Replace port dropdown with Web Serial placeholder. */
window.loadPorts = function () {
  const sel = document.getElementById("serial-port-sel");
  if (!sel) return;
  sel.innerHTML = "";
  const opt = document.createElement("option");
  opt.value       = "__webserial__";
  opt.textContent = "Click Connect to pick port…";
  sel.appendChild(opt);
};

/** Connect / disconnect via Web Serial API browser dialog. */
window.serialConnect = async function () {
  const btn  = document.getElementById("serial-connect-btn");
  const stat = document.getElementById("serial-status");
  const baud = parseInt(document.getElementById("serial-baud-sel").value, 10);

  if (bruceSerial.connected) {
    await bruceSerial.disconnect();
    stat.textContent = "";
    stat.className   = "disconnected";
    _showConnectScreen();
    return;
  }

  if (!("serial" in navigator)) {
    stat.textContent = "Web Serial not supported – use Chrome / Edge / Opera.";
    return;
  }

  btn.textContent  = "Connecting…";
  btn.disabled     = true;
  stat.textContent = "";

  try {
    await bruceSerial.connect(baud);
    stat.textContent = "";
    stat.className   = "connected";
    _showMainUI(baud + " baud");
    try { await fetchSystemInfo(); fetchFiles("LittleFS", "/"); } catch (_) {}
  } catch (e) {
    stat.textContent = e.name === "NotFoundError"
      ? "No port selected."
      : "Error: " + e.message;
    stat.className  = "disconnected";
    btn.textContent = "Connect";
  }
  btn.disabled = false;
};

// ── Init ──────────────────────────────────────────────────────────────
(function () {
  loadPorts();

  if (!("serial" in navigator)) {
    const stat = document.getElementById("serial-status");
    if (stat) {
      stat.textContent = "Web Serial not supported – use Chrome, Edge, or Opera.";
      stat.className   = "disconnected";
    }
    const btn = document.getElementById("serial-connect-btn");
    if (btn) btn.disabled = true;
  }

  // Port-list refresh button is meaningless with Web Serial (browser dialog).
  const rbtn = document.getElementById("serial-refresh-btn");
  if (rbtn) rbtn.style.visibility = "hidden";
})();
