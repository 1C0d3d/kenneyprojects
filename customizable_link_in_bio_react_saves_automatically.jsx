import React, { useEffect, useState } from "react";

const STORAGE_KEY = "link_in_bio_v1";

function isHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.map((p) => p[0]).join("").substring(0, 2).toUpperCase();
}

function isDataUrl(s: string): boolean {
  return /^data:[^;]+;base64,/.test(s);
}

// Robust copy helper with fallbacks (Clipboard API may be blocked in sandbox)
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator?.clipboard && (window as any).isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {}
  try {
    window.prompt("Copy manually:", text);
  } catch {}
  return false;
}

// ---------------- Minimal ZIP (store) builder for a single file ----------------
// Creates a ZIP Blob containing one file without compression.
// References: PKZIP APPNOTE (local file header 0x04034b50, central dir 0x02014b50, EOCD 0x06054b50)
function crc32(buf: Uint8Array): number {
  // Precompute table once
  if (!(crc32 as any)._t) {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    (crc32 as any)._t = t;
  }
  const table: Uint32Array = (crc32 as any)._t;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n: number) { const b = new Uint8Array(2); const v = new DataView(b.buffer); v.setUint16(0, n, true); return b; }
function u32(n: number) { const b = new Uint8Array(4); const v = new DataView(b.buffer); v.setUint32(0, n, true); return b; }

function encodeUTF8(str: string) { return new TextEncoder().encode(str); }

function makeZipSingleFile(name: string, content: Uint8Array): Blob {
  const filenameBytes = encodeUTF8(name);
  const now = new Date();
  const dostime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (Math.floor(now.getSeconds() / 2))) & 0xffff;
  const dosdate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  const c = crc32(content);
  const compSize = content.length; // store (no compression)
  const uncompSize = content.length;

  // Local File Header
  const LFH = [
    u32(0x04034b50),      // signature
    u16(20),              // version needed to extract
    u16(0),               // general purpose bit flag
    u16(0),               // compression method (0 = store)
    u16(dostime),         // last mod file time
    u16(dosdate),         // last mod file date
    u32(c),               // CRC-32
    u32(compSize),        // compressed size
    u32(uncompSize),      // uncompressed size
    u16(filenameBytes.length), // file name length
    u16(0),               // extra field length
    filenameBytes,        // file name
    content,              // file data
  ];

  const lfhSize = LFH.reduce((n, part) => n + (part as Uint8Array).length, 0);

  // Central Directory File Header
  const CDFH = [
    u32(0x02014b50),
    u16(20), // version made by
    u16(20), // version needed to extract
    u16(0),  // general purpose bit flag
    u16(0),  // compression method
    u16(dostime),
    u16(dosdate),
    u32(c),
    u32(compSize),
    u32(uncompSize),
    u16(filenameBytes.length),
    u16(0), // extra length
    u16(0), // file comment length
    u16(0), // disk number start
    u16(0), // internal file attributes
    u32(0), // external file attributes
    u32(0), // relative offset of local header (at 0 for first file)
    filenameBytes,
  ];

  const cdSize = CDFH.reduce((n, part) => n + (part as Uint8Array).length, 0);

  // End of Central Directory
  const EOCD = [
    u32(0x06054b50),
    u16(0), // number of this disk
    u16(0), // disk with start of central directory
    u16(1), // total entries on this disk
    u16(1), // total entries
    u32(cdSize), // size of central directory
    u32(lfhSize), // offset of start of central directory (immediately after LFH+data)
    u16(0), // ZIP file comment length
  ];

  // Concat all parts
  const chunks: Uint8Array[] = [...LFH, ...CDFH, ...EOCD] as unknown as Uint8Array[];
  const total = chunks.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of chunks) { out.set(p, off); off += p.length; }
  return new Blob([out], { type: "application/zip" });
}
// ---------------------------------------------------------------------------

type Profile = {
  name: string;
  bio: string;
  accent: string;
  avatarDataUrl: string | null;
};

type LinkItem = { id: number; title: string; url: string };

export default function LinkInBioCanvas() {
  const [profile, setProfile] = useState<Profile>({
    name: "Your Name",
    bio: "A short bio — say something catchy.",
    accent: "#3b82f6",
    avatarDataUrl: null,
  });

  const [links, setLinks] = useState<LinkItem[]>([
    { id: 1, title: "My Blog", url: "https://example.com" },
    { id: 2, title: "YouTube", url: "https://youtube.com" },
  ]);

  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  // Fallback export preview state for sandboxed environments
  const [exportHref, setExportHref] = useState<string | null>(null);
  const [exportText, setExportText] = useState<string | null>(null);
  const [exportZipHref, setExportZipHref] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        setProfile(parsed.profile || profile);
        setLinks(parsed.links || links);
        setSavedAt(parsed.savedAt);
      }
    } catch {}
    // tiny non-invasive tests
    console.assert(initialsFromName("Ada Lovelace") === "AL", "initials test");
    console.assert(isHttpUrl("https://example.com") === true, "url test");
    // ZIP smoke test (structure only)
    const testBlob = makeZipSingleFile("test.txt", new TextEncoder().encode("ok"));
    console.assert(testBlob.size > 0, "zip blob test");
  }, []);

  useEffect(() => {
    const data = { profile, links, savedAt: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    setSavedAt(data.savedAt);
  }, [profile, links]);

  function addLink() {
    const id = Date.now();
    setLinks([...links, { id, title: "New Link", url: "https://" }]);
  }

  function updateLink(id: number, patch: Partial<{ title: string; url: string }>) {
    setLinks((l) => l.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  function removeLink(id: number) {
    setLinks((l) => l.filter((x) => x.id !== id));
  }

  function moveLink(id: number, dir: "up" | "down") {
    setLinks((arr) => {
      const i = arr.findIndex((x) => x.id === id);
      if (i === -1) return arr;
      const j = dir === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= arr.length) return arr;
      const newArr = [...arr];
      [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
      return newArr;
    });
  }

  async function exportJSON() {
    const payload = { profile, links, exportedAt: new Date().toISOString() };
    const json = JSON.stringify(payload, null, 2);

    // 1) Try the File System Access API
    const supportsFS = typeof (window as any).showSaveFilePicker === "function";
    if (supportsFS) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: "link-in-bio.json",
          types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(new Blob([json], { type: "application/json" }));
        await writable.close();
        setToast("Saved to file");
        setTimeout(() => setToast(""), 1200);
        setExportHref(null);
        setExportText(null);
        return;
      } catch (err: any) {}
    }

    // 2) Classic download via <a download>
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "link-in-bio.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setToast("Downloading...");
      setTimeout(() => setToast(""), 1200);
      setExportHref(null);
      setExportText(null);
      return;
    } catch {}

    // 3) Fallback
    const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);
    setExportHref(dataUrl);
    setExportText(json);
    setToast("Browser blocked download — use fallback link");
    setTimeout(() => setToast(""), 2000);
  }

  async function exportZIP() {
    const payload = { profile, links, exportedAt: new Date().toISOString() };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
    const zipBlob = makeZipSingleFile("link-in-bio.json", jsonBytes);

    // Try File System Access API first
    const supportsFS = typeof (window as any).showSaveFilePicker === "function";
    if (supportsFS) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: "link-in-bio.zip",
          types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(zipBlob);
        await writable.close();
        setToast("Saved ZIP");
        setTimeout(() => setToast(""), 1200);
        setExportZipHref(null);
        return;
      } catch (err) {}
    }

    // Then try <a download>
    try {
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "link-in-bio.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setToast("Downloading ZIP...");
      setTimeout(() => setToast(""), 1200);
      setExportZipHref(null);
      return;
    } catch {}

    // Fallback: provide data URL link for manual save (may be large)
    try {
      const reader = new FileReader();
      reader.onload = () => {
        setExportZipHref(reader.result as string);
        setToast("Browser blocked download — use ZIP fallback link");
        setTimeout(() => setToast(""), 2000);
      };
      reader.readAsDataURL(zipBlob);
    } catch {}
  }

  function importJSON(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        if (parsed.profile) setProfile(parsed.profile);
        if (Array.isArray(parsed.links)) setLinks(parsed.links);
        setToast("Imported JSON");
      } catch {
        setToast("Import failed");
      }
      setTimeout(() => setToast(""), 1200);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function onAvatarFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => setProfile((p) => ({ ...p, avatarDataUrl: reader.result as string }));
    reader.readAsDataURL(file);
  }

  function clearAvatar() {
    setProfile((p) => ({ ...p, avatarDataUrl: null }));
  }

  function resetAll() {
    if (!confirm("Reset all saved data to defaults?")) return;
    localStorage.removeItem(STORAGE_KEY);
    setProfile({ name: "Your Name", bio: "A short bio — say something catchy.", accent: "#3b82f6", avatarDataUrl: null });
    setLinks([
      { id: 1, title: "My Blog", url: "https://example.com" },
      { id: 2, title: "YouTube", url: "https://youtube.com" },
    ]);
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6 md:p-12 font-sans">
      <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
        <div className="bg-white rounded-2xl shadow p-6">
          <h2 className="text-xl font-semibold mb-4">Editor</h2>

          <label className="block text-sm font-medium">Profile name</label>
          <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} className="w-full border rounded p-2 mb-3" />

          <label className="block text-sm font-medium">Short bio</label>
          <textarea value={profile.bio} onChange={(e) => setProfile({ ...profile, bio: e.target.value })} className="w-full border rounded p-2 mb-3" rows={3} />

          <label className="block text-sm font-medium">Accent color</label>
          <input type="color" value={profile.accent} onChange={(e) => setProfile({ ...profile, accent: e.target.value })} className="w-12 h-10 border rounded mb-4" />

          <label className="block text-sm font-medium mb-1">Profile picture</label>
          <div className="flex gap-3 mb-3">
            <label className="px-3 py-2 border rounded cursor-pointer">
              Upload
              <input type="file" accept="image/*" onChange={onAvatarFile} className="hidden" />
            </label>
            {profile.avatarDataUrl && (
              <button onClick={clearAvatar} className="px-3 py-2 border rounded text-red-600">Remove</button>
            )}
          </div>

          <div className="flex justify-between items-center mb-3">
            <h3 className="font-medium">Links</h3>
            <button onClick={addLink} className="px-3 py-1 bg-black text-white rounded text-sm">+ Add</button>
          </div>

          {links.map((ln) => (
            <div key={ln.id} className="border rounded p-3 mb-3">
              <input value={ln.title} onChange={(e) => updateLink(ln.id, { title: e.target.value })} className="w-full border rounded p-1 mb-2" placeholder="Title" />
              <input value={ln.url} onChange={(e) => updateLink(ln.id, { url: e.target.value })} className="w-full border rounded p-1 mb-2" placeholder="https://..." />
              <div className="flex gap-2 text-sm">
                <button onClick={() => moveLink(ln.id, "up")} className="border rounded px-2">↑</button>
                <button onClick={() => moveLink(ln.id, "down")} className="border rounded px-2">↓</button>
                <button onClick={() => removeLink(ln.id)} className="ml-auto border rounded px-2 text-red-600">Delete</button>
              </div>
            </div>
          ))}

          <div className="flex gap-3 mt-4 items-center flex-wrap">
            <button onClick={exportJSON} className="px-3 py-2 border rounded">Export JSON</button>
            <button onClick={exportZIP} className="px-3 py-2 border rounded">Export ZIP</button>
            <label className="px-3 py-2 border rounded cursor-pointer">
              Import JSON
              <input type="file" accept="application/json" onChange={importJSON} className="hidden" />
            </label>
            <button onClick={resetAll} className="px-3 py-2 border rounded text-red-600">Reset</button>
          </div>

          {/* Fallback UI when downloads are blocked (e.g., sandboxed canvas) */}
          {(exportHref || exportZipHref) && (
            <div className="mt-4 p-3 border rounded bg-amber-50 text-sm">
              <div className="font-medium mb-2">Download was blocked by the browser.</div>
              <ol className="list-decimal ml-5 space-y-1">
                {exportHref && (
                  <li>
                    <a href={exportHref} target="_blank" rel="noreferrer" className="underline">
                      Open JSON in a new tab
                    </a>
                    , then press <span className="font-semibold">Ctrl/Cmd + S</span> to save as <code>link-in-bio.json</code>.
                  </li>
                )}
                {exportZipHref && (
                  <li>
                    <a href={exportZipHref} target="_blank" rel="noreferrer" className="underline">
                      Open ZIP data URL
                    </a>
                    , then choose <span className="font-semibold">Save As…</span> and rename to <code>link-in-bio.zip</code>.
                  </li>
                )}
                {exportHref && (
                  <li>
                    Or copy the JSON contents below and paste into <code>link-in-bio.json</code>.
                    <button
                      onClick={async () => {
                        if (exportText) {
                          const ok = await copyText(exportText);
                          setToast(ok ? "JSON copied" : "Copy blocked");
                          setTimeout(() => setToast(""), 1200);
                        }
                      }}
                      className="ml-2 px-2 py-1 border rounded"
                    >
                      Copy JSON
                    </button>
                  </li>
                )}
              </ol>
              {exportHref && (
                <textarea
                  className="mt-2 w-full h-40 border rounded p-2 font-mono text-xs"
                  value={exportText || ""}
                  readOnly
                />
              )}
            </div>
          )}

          <div className="mt-2 text-xs text-gray-500">Last saved: {savedAt ? new Date(savedAt).toLocaleString() : "—"}</div>
        </div>

        <div className="text-center bg-white rounded-2xl shadow p-6">
          <div className="mx-auto w-28 h-28 rounded-full flex items-center justify-center overflow-hidden" style={{ background: profile.accent }}>
            {profile.avatarDataUrl ? (
              <img src={profile.avatarDataUrl} alt="avatar" className="w-full h-full object-cover" />
            ) : (
              <span className="text-white text-2xl font-bold">{initialsFromName(profile.name)}</span>
            )}
          </div>
          <h2 className="mt-4 text-xl font-semibold">{profile.name}</h2>
          <p className="text-sm text-gray-600">{profile.bio}</p>
          <div className="mt-5 space-y-2">
            {links.map((ln) => (
              <a key={ln.id} href={ln.url} target="_blank" rel="noreferrer" className="block border rounded p-2" style={{ borderColor: profile.accent }}>
                {ln.title}
              </a>
            ))}
          </div>
          {toast && <div className="fixed bottom-6 right-6 bg-black text-white rounded px-3 py-2">{toast}</div>}
        </div>
      </div>
    </div>
  );
}
