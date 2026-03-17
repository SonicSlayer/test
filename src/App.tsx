import React, { useState, useCallback, useRef } from 'react';
import { UploadCloud, FileText, Download, Settings, Trash2 } from 'lucide-react';

interface LanguageFile {
  id: string;
  name: string;
  code: string;
  content: string[];
}

function encodeUTF8(str: string) {
  return new TextEncoder().encode(str);
}

const App = () => {
  const [files, setFiles] = useState<LanguageFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  
  // Advanced settings
  const [headerType, setHeaderType] = useState<'count_only' | 'count_then_array_ptr' | 'array_ptr_then_count'>('count_only');
  const [magicBytes, setMagicBytes] = useState<string>('');
  const [useNullTerminator, setUseNullTerminator] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const processFiles = async (fileList: FileList | File[]) => {
    const newFiles: LanguageFile[] = [];
    
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      if (!file.name.endsWith('.txt')) continue;
      
      const text = await file.text();
      // File.WriteAllLines ends with \r\n and handles newlines by writing them as-is (which breaks lines if strings have \n)
      // We assume each line in the txt is a separate string. 
      // Need to handle the last empty line from WriteAllLines if present, usually not an issue if we just split and pop if empty at end.
      const lines = text.split(/\r?\n/);
      // Remove last empty line if it was just a newline at EOF from WriteAllLines
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      
      let code = file.name.replace('.txt', '');
      const match = code.match(/_([a-zA-Z0-9\-]+)$/);
      if (match) {
        code = match[1];
      }
      
      newFiles.push({
        id: Math.random().toString(36).substring(7),
        name: file.name,
        code: code,
        content: lines
      });
    }
    
    setFiles(prev => [...prev, ...newFiles]);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(e.target.files);
    }
  };

  const removeFile = (id: string) => {
    setFiles(files.filter(f => f.id !== id));
  };

  const updateLanguageCode = (id: string, newCode: string) => {
    setFiles(files.map(f => f.id === id ? { ...f, code: newCode } : f));
  };

  const generateBinary = () => {
    if (files.length === 0) return;
    
    let magicBuffer = new Uint8Array(0);
    if (magicBytes) {
      const bytes = magicBytes.split(' ').map(x => parseInt(x, 16)).filter(x => !isNaN(x));
      magicBuffer = new Uint8Array(bytes);
    }

    // Determine initial header size
    let headerSize = magicBuffer.length;
    if (headerType === 'count_only') headerSize += 4;
    else if (headerType === 'count_then_array_ptr') headerSize += 8;
    else if (headerType === 'array_ptr_then_count') headerSize += 8;
    
    let currentDataOffset = headerSize + files.length * 16;
    
    const langDataList = files.map(file => {
      // Encode language code (no null terminator for code in C# usually unless specified)
      const codeBytesRaw = encodeUTF8(file.code);
      const codeBytes = new Uint8Array(codeBytesRaw.length + (useNullTerminator ? 1 : 0));
      codeBytes.set(codeBytesRaw);
      
      const stringsData = file.content.map(str => {
        const raw = encodeUTF8(str);
        const sBytes = new Uint8Array(raw.length + (useNullTerminator ? 1 : 0));
        sBytes.set(raw);
        return sBytes;
      });
      
      const stringsHeadersSize = stringsData.length * 8;
      const stringsDataSize = stringsData.reduce((acc, s) => acc + s.length, 0);
      
      return {
        codeBytes,
        stringsData,
        stringsHeadersSize,
        stringsDataSize,
        totalDataSize: codeBytes.length + stringsHeadersSize + stringsDataSize
      };
    });
    
    const totalSize = currentDataOffset + langDataList.reduce((acc, ld) => acc + ld.totalDataSize, 0);
    
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    
    // Write magic
    u8.set(magicBuffer, 0);
    
    // Write LocaleFile header
    let fileHeaderOffset = magicBuffer.length;
    if (headerType === 'count_only') {
      view.setInt32(fileHeaderOffset, files.length, true); // LanguagesCount
    } else if (headerType === 'count_then_array_ptr') {
      view.setInt32(fileHeaderOffset, files.length, true); // LanguagesCount
      // Pointer is relative to its own offset
      view.setInt32(fileHeaderOffset + 4, headerSize - (fileHeaderOffset + 4), true); // Languages array offset
    } else if (headerType === 'array_ptr_then_count') {
      view.setInt32(fileHeaderOffset, headerSize - fileHeaderOffset, true); // Languages array offset
      view.setInt32(fileHeaderOffset + 4, files.length, true); // LanguagesCount
    }
    
    let arrayHeaderOffset = headerSize;
    let dataWriteOffset = headerSize + files.length * 16;
    
    for (let i = 0; i < files.length; i++) {
      const ld = langDataList[i];
      
      // LanguageCodeOffset
      view.setInt32(arrayHeaderOffset, dataWriteOffset - arrayHeaderOffset, true);
      // LanguageCodeLength
      view.setInt32(arrayHeaderOffset + 4, ld.codeBytes.length, true);
      
      // Write LanguageCode bytes
      u8.set(ld.codeBytes, dataWriteOffset);
      dataWriteOffset += ld.codeBytes.length;
      
      // StringsOffset
      view.setInt32(arrayHeaderOffset + 8, dataWriteOffset - (arrayHeaderOffset + 8), true);
      // StringsCount
      view.setInt32(arrayHeaderOffset + 12, ld.stringsData.length, true);
      
      let stringHeaderWriteOffset = dataWriteOffset;
      let stringDataWriteOffset = dataWriteOffset + ld.stringsHeadersSize;
      
      for (let j = 0; j < ld.stringsData.length; j++) {
        const sData = ld.stringsData[j];
        
        // StringOffset
        view.setInt32(stringHeaderWriteOffset, stringDataWriteOffset - stringHeaderWriteOffset, true);
        // StringLength
        view.setInt32(stringHeaderWriteOffset + 4, sData.length, true);
        
        // Write string bytes
        u8.set(sData, stringDataWriteOffset);
        stringDataWriteOffset += sData.length;
        
        stringHeaderWriteOffset += 8;
      }
      
      dataWriteOffset = stringDataWriteOffset;
      arrayHeaderOffset += 16;
    }
    
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'locale.strings';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8 font-sans text-gray-900">
      <div className="max-w-4xl mx-auto space-y-8">
        <header className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-gray-800">Locale Strings Repacker</h1>
          <p className="text-gray-500">Repack extracted .txt files back into a binary locale.strings file.</p>
        </header>

        <div 
          className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors cursor-pointer
            ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-blue-400 bg-white'}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input 
            type="file" 
            ref={fileInputRef} 
            className="hidden" 
            multiple 
            accept=".txt" 
            onChange={handleFileInput} 
          />
          <UploadCloud className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-medium">Drag & Drop .txt files here</h3>
          <p className="text-sm text-gray-500 mt-2">or click to select files</p>
          <p className="text-xs text-gray-400 mt-4">Expected naming: locale.strings_en.txt</p>
        </div>

        {files.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <div className="p-4 bg-gray-50 border-b flex justify-between items-center">
              <h2 className="font-semibold text-gray-700">Loaded Languages ({files.length})</h2>
              <button 
                onClick={() => setFiles([])}
                className="text-sm text-red-600 hover:text-red-800 font-medium"
              >
                Clear All
              </button>
            </div>
            <ul className="divide-y divide-gray-100">
              {files.map((file) => (
                <li key={file.id} className="p-4 flex items-center justify-between hover:bg-gray-50 transition-colors">
                  <div className="flex items-center space-x-4">
                    <div className="bg-blue-100 p-2 rounded-lg">
                      <FileText className="w-6 h-6 text-blue-600" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-800">{file.name}</p>
                      <p className="text-xs text-gray-500">{file.content.length} strings loaded</p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-4">
                    <div className="flex items-center space-x-2">
                      <label className="text-sm text-gray-600">Lang Code:</label>
                      <input 
                        type="text" 
                        value={file.code}
                        onChange={(e) => updateLanguageCode(file.id, e.target.value)}
                        className="border border-gray-300 rounded px-2 py-1 w-20 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <button 
                      onClick={() => removeFile(file.id)}
                      className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                      title="Remove"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-col space-y-4">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="flex items-center justify-center space-x-2 text-sm text-gray-600 hover:text-gray-900 mx-auto"
          >
            <Settings className="w-4 h-4" />
            <span>Advanced Binary Settings</span>
          </button>

          {showSettings && (
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 space-y-4 text-sm">
              <h3 className="font-medium text-gray-800 border-b pb-2">Binary Format Configuration</h3>
              <p className="text-gray-500 text-xs mb-4">Only change these if the generated file doesn't match your game's format.</p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="block font-medium text-gray-700">File Header Layout</label>
                  <select 
                    value={headerType}
                    onChange={(e) => setHeaderType(e.target.value as any)}
                    className="w-full border border-gray-300 rounded-md p-2 bg-white"
                  >
                    <option value="count_only">[Int32] LanguagesCount (Default)</option>
                    <option value="count_then_array_ptr">[Int32] Count, [Ptr] ArrayOffset</option>
                    <option value="array_ptr_then_count">[Ptr] ArrayOffset, [Int32] Count</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="block font-medium text-gray-700">Magic Bytes (Hex)</label>
                  <input 
                    type="text" 
                    value={magicBytes}
                    onChange={(e) => setMagicBytes(e.target.value)}
                    placeholder="e.g. 4C 4F 43 4C"
                    className="w-full border border-gray-300 rounded-md p-2"
                  />
                  <p className="text-xs text-gray-500">Optional magic header bytes before the main header.</p>
                </div>

                <div className="space-y-2 md:col-span-2">
                  <label className="flex items-center space-x-2 cursor-pointer">
                    <input 
                      type="checkbox"
                      checked={useNullTerminator}
                      onChange={(e) => setUseNullTerminator(e.target.checked)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="font-medium text-gray-700">Append null terminator to strings</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          <button
            onClick={generateBinary}
            disabled={files.length === 0}
            className={`flex items-center justify-center space-x-2 w-full py-4 rounded-xl font-bold text-lg text-white transition-all
              ${files.length > 0 
                ? 'bg-blue-600 hover:bg-blue-700 shadow-md hover:shadow-lg' 
                : 'bg-gray-300 cursor-not-allowed'}`}
          >
            <Download className="w-6 h-6" />
            <span>Generate locale.strings</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;