import React, { useState, useMemo, useRef } from 'react';
import { FileCode, Save, Search, Upload, CheckCircle2, AlertCircle } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- TYPES ---
type StrEntry = {
  id: string;
  offset: number;
  originalText: string;
  translatedText: string;
  originalBytes: number;
  isModified: boolean;
  pointers: number[]; // where the offset is referenced in the file
};

// --- MOCK DATA ---
const mockEntries: StrEntry[] = [
  { id: '1', offset: 0x2250, originalText: 'Day', translatedText: 'Day', originalBytes: 6, isModified: false, pointers: [] },
  { id: '2', offset: 0x2260, originalText: 'Last Day', translatedText: 'Last Day', originalBytes: 16, isModified: false, pointers: [] },
  { id: '3', offset: 0x2280, originalText: 'Morning', translatedText: 'Morning', originalBytes: 14, isModified: false, pointers: [] },
  { id: '4', offset: 0x2290, originalText: 'Daytime', translatedText: 'Daytime', originalBytes: 14, isModified: false, pointers: [] },
];

// --- PARSING LOGIC ---
// Scan for UTF-16LE strings (min length 2)
function extractStrings(buffer: ArrayBuffer): StrEntry[] {
  const bytes = new Uint8Array(buffer);
  const dataView = new DataView(buffer);
  const entries: StrEntry[] = [];
  let currentString: number[] = [];
  let startOffset = -1;

  for (let i = 0; i < bytes.length - 1; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    // Allow typical printables + some control brackets
    const isPrintable =
      (code >= 32 && code <= 126) || 
      (code >= 160 && code <= 0x10FFFF) || 
      code === 10 || code === 13;

    if (isPrintable) {
      if (startOffset === -1) {
        startOffset = i;
      }
      currentString.push(code);
    } else if (code === 0 && startOffset !== -1) {
      // Null terminator found
      if (currentString.length >= 2) {
        const text = String.fromCharCode(...currentString);
        
        // Find pointers to this string (32-bit little endian)
        const pointers: number[] = [];
        // Scan first 10% of file for pointers to be safe, or just header area
        const searchLimit = Math.min(bytes.length - 4, 0x10000); 
        for (let p = 0; p < searchLimit; p += 4) {
          if (dataView.getUint32(p, true) === startOffset) {
            pointers.push(p);
          }
        }

        entries.push({
          id: startOffset.toString(),
          offset: startOffset,
          originalText: text,
          translatedText: text,
          originalBytes: currentString.length * 2,
          isModified: false,
          pointers,
        });
      }
      currentString = [];
      startOffset = -1;
    } else {
      currentString = [];
      startOffset = -1;
    }
  }
  return entries;
}

// Generate the patched file buffer
function generatePatchedFile(originalBuffer: ArrayBuffer, entries: StrEntry[]): Uint8Array {
  const originalBytes = new Uint8Array(originalBuffer);
  let newBuffer = new Uint8Array(originalBytes);

  // For entries that grew in size, we append them to the end
  let currentAppendOffset = newBuffer.length;
  
  // We need an extensible array if we append a lot
  const chunks: Uint8Array[] = [originalBytes];

  for (const entry of entries) {
    if (!entry.isModified) continue;

    // Convert string to UTF-16LE
    const textChars = entry.translatedText;
    const newBytesLength = textChars.length * 2 + 2; // +2 for null terminator
    const newBytes = new Uint8Array(newBytesLength);
    for (let i = 0; i < textChars.length; i++) {
      const code = textChars.charCodeAt(i);
      newBytes[i * 2] = code & 0xff;
      newBytes[i * 2 + 1] = code >> 8;
    }
    // null terminator is already 0

    if (newBytesLength <= entry.originalBytes) {
      // Fit in place
      for (let i = 0; i < newBytesLength; i++) {
        chunks[0][entry.offset + i] = newBytes[i];
      }
      // pad rest with nulls
      for (let i = newBytesLength; i < entry.originalBytes + 2; i++) {
        if (entry.offset + i < chunks[0].length) {
          chunks[0][entry.offset + i] = 0;
        }
      }
    } else {
      // Append to end of file to "remove char limit"
      const newOffset = currentAppendOffset;
      chunks.push(newBytes);
      currentAppendOffset += newBytesLength;

      // Update pointers if any were found
      for (const ptrOffset of entry.pointers) {
        // Update in chunk 0
        const dv = new DataView(chunks[0].buffer);
        dv.setUint32(ptrOffset, newOffset, true);
      }
    }
  }

  // Concatenate all chunks
  const totalLength = chunks.reduce((acc, curr) => acc + curr.length, 0);
  const finalBytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    finalBytes.set(chunk, offset);
    offset += chunk.length;
  }

  return finalBytes;
}

export function App() {
  const [entries, setEntries] = useState<StrEntry[]>(mockEntries);
  const [searchTerm, setSearchTerm] = useState('');
  const [fileName, setFileName] = useState('MES_SYSTEM_USA.bin');
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleTextChange = (id: string, newText: string) => {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              translatedText: newText,
              isModified: newText !== entry.originalText,
            }
          : entry
      )
    );
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      const buffer = evt.target?.result as ArrayBuffer;
      setFileBuffer(buffer);
      const parsedEntries = extractStrings(buffer);
      if (parsedEntries.length > 0) {
        setEntries(parsedEntries);
      } else {
        alert('No strings found in this file or unrecognized format.');
      }
    };
    reader.readAsArrayBuffer(file);
    
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSave = () => {
    if (!fileBuffer) {
      alert('Please load a file first.');
      return;
    }
    const patchedBytes = generatePatchedFile(fileBuffer, entries);
    
    const blob = new Blob([patchedBytes as any], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'PATCHED_' + fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const filteredEntries = useMemo(() => {
    if (!searchTerm) return entries;
    const lower = searchTerm.toLowerCase();
    return entries.filter(
      (e) =>
        e.originalText.toLowerCase().includes(lower) ||
        e.translatedText.toLowerCase().includes(lower) ||
        e.offset.toString(16).includes(lower)
    );
  }, [entries, searchTerm]);

  return (
    <div className="min-h-screen bg-[#2b2144] p-4 md:p-8 font-sans text-white">
      <div className="mx-auto max-w-5xl space-y-6">
        
        {/* Header Panel */}
        <div className="flex flex-col md:flex-row items-center justify-between rounded-xl bg-[#1c112d] border border-[#382755] p-6 shadow-xl">
          <div className="flex items-center gap-4 mb-4 md:mb-0">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[#3e1f44] border border-[#d93b82]/30">
              <FileCode className="h-7 w-7 text-[#d93b82]" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-wide text-[#f2eafb]">
                STRPACK<span className="text-[#d93b82]">_EDITOR</span>
              </h1>
              <p className="text-sm text-[#9f8db1]">Dead or Alive Xtreme 3 Fortune Modification Tool</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <input 
              type="file" 
              ref={fileInputRef} 
              className="hidden" 
              accept=".bin" 
              onChange={handleFileUpload} 
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-2 rounded-lg bg-[#3a2c5a] px-4 py-2.5 text-sm font-semibold text-[#e2d5f8] transition-colors hover:bg-[#4a3970]"
            >
              <Upload className="h-4 w-4" />
              Load File
            </button>
            <button
              onClick={handleSave}
              className="flex items-center gap-2 rounded-lg bg-[#c5304a] px-5 py-2.5 text-sm font-bold text-white shadow-lg transition-colors hover:bg-[#a5263b] active:scale-95"
            >
              <Save className="h-4 w-4" />
              Save Patched File
            </button>
          </div>
        </div>

        {/* Search & Info Panel */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 rounded-xl bg-[#1c112d] border border-[#382755] p-4 shadow-md">
          <div className="relative w-full sm:w-96">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#6b5a88]" />
            <input
              type="text"
              placeholder="Search dialogs or control codes..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded-lg border border-[#382755] bg-[#130b20] py-2.5 pl-10 pr-4 text-sm text-[#e2d5f8] placeholder-[#6b5a88] outline-none transition-all focus:border-[#d93b82] focus:ring-1 focus:ring-[#d93b82]"
            />
          </div>
          
          <div className="flex items-center rounded-lg bg-[#231737] px-4 py-2 text-sm text-[#9f8db1] border border-[#382755]/50 whitespace-nowrap">
            File: <span className="ml-1 font-bold text-[#e2d5f8]">{fileName}</span>
            <span className="mx-2 text-[#4a3970]">|</span>
            Found: <span className="mx-1 font-bold text-[#d93b82]">{entries.length}</span> strings
          </div>
        </div>

        {/* Editor List Panel */}
        <div className="rounded-xl bg-[#1c112d] border border-[#382755] shadow-xl overflow-hidden flex flex-col h-[calc(100vh-280px)]">
          
          {/* Table Header */}
          <div className="flex items-center border-b border-[#382755] bg-[#1c112d] px-6 py-4 text-xs font-bold tracking-wider text-[#7d6c95]">
            <div className="w-24 shrink-0">OFFSET</div>
            <div className="flex-1 pr-6">ORIGINAL TEXT</div>
            <div className="flex-1">PATCHED TRANSLATION</div>
          </div>

          {/* List Content */}
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {filteredEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-[#6b5a88]">
                <AlertCircle className="h-10 w-10 mb-2 opacity-50" />
                <p>No strings found matching your search.</p>
              </div>
            ) : (
              <div className="divide-y divide-[#382755]/50">
                {filteredEntries.map((entry) => {
                  const currentBytes = entry.translatedText.length * 2; // naive byte count
                  const isLonger = currentBytes > entry.originalBytes;
                  
                  return (
                    <div key={entry.id} className="flex items-start px-6 py-5 hover:bg-[#231737]/50 transition-colors">
                      
                      {/* Offset */}
                      <div className="w-24 shrink-0 pt-2 font-mono text-xs text-[#6b5a88]">
                        0x{entry.offset.toString(16).toUpperCase().padStart(4, '0')}
                      </div>
                      
                      {/* Original */}
                      <div className="flex-1 pr-6 pt-1.5">
                        <p className="whitespace-pre-wrap break-all text-sm font-medium text-[#f2eafb] leading-relaxed">
                          {entry.originalText}
                        </p>
                      </div>
                      
                      {/* Editor */}
                      <div className="flex-1 flex flex-col gap-2">
                        <textarea
                          value={entry.translatedText}
                          onChange={(e) => handleTextChange(entry.id, e.target.value)}
                          className={cn(
                            "w-full resize-y min-h-[60px] rounded-lg border bg-[#130b20] p-3 text-sm text-[#e2d5f8] outline-none transition-all placeholder-[#4a3970]",
                            entry.isModified 
                              ? "border-[#d93b82]/50 focus:border-[#d93b82] focus:ring-1 focus:ring-[#d93b82]" 
                              : "border-[#382755] focus:border-[#6c489c] focus:ring-1 focus:ring-[#6c489c]"
                          )}
                          spellCheck={false}
                        />
                        
                        <div className="flex items-center justify-between text-xs">
                          <span className={cn(
                            "flex items-center gap-1.5 font-medium",
                            entry.isModified ? "text-[#d93b82]" : "text-[#5a4871]"
                          )}>
                            {entry.isModified ? (
                              <><CheckCircle2 className="h-3.5 w-3.5" /> Modified</>
                            ) : (
                              'Unchanged'
                            )}
                          </span>
                          
                          <div className={cn(
                            "flex items-center rounded-md px-2 py-1 font-mono",
                            isLonger ? "bg-[#c5304a]/10 text-[#d93b82]" : "bg-[#231737] text-[#7d6c95]"
                          )}>
                            {currentBytes} / {entry.originalBytes} bytes
                          </div>
                        </div>
                      </div>
                      
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
