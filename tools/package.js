#!/usr/bin/env node
/**
 * Zero-dependency VSIX packager.
 * Creates a valid .vsix file using only Node.js built-in modules.
 * No npm packages required — bypasses corporate registry restrictions.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const NAME = 'local-llm-chat';
const VERSION = '0.2.0';
const VSIX_FILE = path.join(ROOT, `${NAME}-${VERSION}.vsix`);

const EXTENSION_FILES = [
  { path: 'extension/package.json', src: 'package.json' },
  { path: 'extension/src/config.js', src: 'src/config.js' },
  { path: 'extension/src/llmClient.js', src: 'src/llmClient.js' },
  { path: 'extension/src/chatProvider.js', src: 'src/chatProvider.js' },
  { path: 'extension/src/extension.js', src: 'src/extension.js' },
  { path: 'extension/src/chatView.html', src: 'src/chatView.html' },
];

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeLocalHeader(comp, uncomp, crc, name, compSize, uncompSize) {
  const nameBuf = Buffer.from(name, 'utf-8');
  const buf = Buffer.alloc(30 + nameBuf.length);
  buf.writeUInt32LE(0x04034b50, 0);  // signature
  buf.writeUInt16LE(20, 4);          // version needed
  buf.writeUInt16LE(8, 6);           // flags (UTF-8 names)
  buf.writeUInt16LE(comp, 8);        // compression method (0=stored, 8=deflated)
  buf.writeUInt16LE(0, 10);          // mod time
  buf.writeUInt16LE(0, 12);          // mod date
  buf.writeUInt32LE(crc, 14);
  buf.writeUInt32LE(compSize, 18);
  buf.writeUInt32LE(uncompSize, 22);
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(0, 28);          // extra field length
  nameBuf.copy(buf, 30);
  return buf;
}

function makeCentralEntry(comp, uncomp, crc, name, compSize, uncompSize, localOffset) {
  const nameBuf = Buffer.from(name, 'utf-8');
  const buf = Buffer.alloc(46 + nameBuf.length);
  buf.writeUInt32LE(0x02014b50, 0);  // signature
  buf.writeUInt16LE(20, 4);          // version made by
  buf.writeUInt16LE(20, 6);          // version needed
  buf.writeUInt16LE(8, 8);           // flags (UTF-8)
  buf.writeUInt16LE(comp, 10);       // compression method
  buf.writeUInt16LE(0, 12);          // mod time
  buf.writeUInt16LE(0, 14);          // mod date
  buf.writeUInt32LE(crc, 16);
  buf.writeUInt32LE(compSize, 20);
  buf.writeUInt32LE(uncompSize, 24);
  buf.writeUInt16LE(nameBuf.length, 28);
  buf.writeUInt16LE(0, 30);           // extra field length
  buf.writeUInt16LE(0, 32);           // file comment length
  buf.writeUInt16LE(0, 34);           // disk number start
  buf.writeUInt16LE(0, 36);           // internal file attributes
  buf.writeUInt32LE(0, 38);           // external file attributes
  buf.writeUInt32LE(localOffset, 42);
  nameBuf.copy(buf, 46);
  return buf;
}

function makeEndCentral(numEntries, centralSize, centralOffset) {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(0x06054b50, 0);   // signature
  buf.writeUInt16LE(0, 4);            // disk number
  buf.writeUInt16LE(0, 6);            // disk with central directory
  buf.writeUInt16LE(numEntries, 8);   // entries on this disk
  buf.writeUInt16LE(numEntries, 10);  // total entries
  buf.writeUInt32LE(centralSize, 12);
  buf.writeUInt32LE(centralOffset, 16);
  buf.writeUInt16LE(0, 20);           // comment length
  return buf;
}

function createZip(files) {
  const localHeaders = [];
  const centralEntries = [];
  let offset = 0;
  const allData = [];

  for (const file of files) {
    const data = file.content;
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const isCompressed = compressed.length < data.length;

    const compSize = isCompressed ? compressed.length : data.length;
    const uncompSize = data.length;
    const method = isCompressed ? 8 : 0;
    const finalData = isCompressed ? compressed : data;

    const localHeader = makeLocalHeader(method, 0, crc, file.name, compSize, uncompSize);
    localHeaders.push({ header: localHeader, data: finalData, offset });

    const centralEntry = makeCentralEntry(method, 0, crc, file.name, compSize, uncompSize, offset);
    centralEntries.push(centralEntry);

    offset += localHeader.length + finalData.length;
  }

  const centralStart = offset;
  const centralBuffer = Buffer.concat(centralEntries);
  const endCentral = makeEndCentral(files.length, centralBuffer.length, centralStart);

  for (const lh of localHeaders) {
    allData.push(lh.header);
    allData.push(lh.data);
  }
  allData.push(centralBuffer);
  allData.push(endCentral);

  return Buffer.concat(allData);
}

// XML content types
function makeContentTypes() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="text/javascript" />
  <Default Extension="html" ContentType="text/html" />
  <Default Extension="yaml" ContentType="text/yaml" />
</Types>`;
}

// VSIX manifest
function makeVsixManifest() {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="local-llm-chat.local-llm-chat" Version="${VERSION}" Publisher="local-llm-chat" Language="en-US" />
    <DisplayName>Local LLM Chat</DisplayName>
    <Description>Chat with local LLMs via YAML-configured models</Description>
    <Tags>llm;chat;local;ai</Tags>
    <GalleryFlags>Public</GalleryFlags>
    <Categories>Chat,Other</Categories>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.VisualStudioEyeball" Path="extension/src/extension.js" />
  </Assets>
</PackageManifest>`;
}

function build() {
  // Read source files
  const files = [];

  // Add metadata files
  files.push({ name: '[Content_Types].xml', content: Buffer.from(makeContentTypes(), 'utf-8') });
  files.push({ name: 'extension.vsixmanifest', content: Buffer.from(makeVsixManifest(), 'utf-8') });

  // Read and add extension files
  for (const entry of EXTENSION_FILES) {
    const srcPath = path.join(ROOT, entry.src);
    if (!fs.existsSync(srcPath)) {
      console.error(`Missing: ${entry.src}`);
      process.exit(1);
    }
    const content = fs.readFileSync(srcPath);
    files.push({ name: entry.path, content });
  }

  // Create ZIP (VSIX)
  const zipBuffer = createZip(files);
  fs.writeFileSync(VSIX_FILE, zipBuffer);

  const sizeKB = (zipBuffer.length / 1024).toFixed(1);
  console.log(`Created: ${VSIX_FILE} (${sizeKB} KB, ${files.length} files)`);
}

build();
