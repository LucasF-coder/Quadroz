const fs = require('fs');
const path = require('path');
const { gzipSync, brotliCompressSync, constants } = require('zlib');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const distDir = path.join(root, 'dist');
const distPublicDir = path.join(distDir, 'public');

const compressibleExtensions = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt', '.xml']);

async function rmrf(targetPath) {
  await fs.promises.rm(targetPath, { recursive: true, force: true });
}

async function ensureDir(targetPath) {
  await fs.promises.mkdir(targetPath, { recursive: true });
}

async function copyRecursive(source, target) {
  await ensureDir(target);
  const entries = await fs.promises.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const dstPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      await copyRecursive(srcPath, dstPath);
      continue;
    }

    await fs.promises.copyFile(srcPath, dstPath);
  }
}

async function walkFiles(basePath, collector = []) {
  const entries = await fs.promises.readdir(basePath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(basePath, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, collector);
      continue;
    }
    collector.push(fullPath);
  }

  return collector;
}

async function precompressFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!compressibleExtensions.has(ext)) return;

  const source = await fs.promises.readFile(filePath);
  if (source.length < 512) return;

  const gzip = gzipSync(source, { level: 9 });
  const brotli = brotliCompressSync(source, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT
    }
  });

  if (gzip.length < source.length) {
    await fs.promises.writeFile(`${filePath}.gz`, gzip);
  }

  if (brotli.length < source.length) {
    await fs.promises.writeFile(`${filePath}.br`, brotli);
  }
}

async function run() {
  await rmrf(distDir);
  await ensureDir(distPublicDir);
  await copyRecursive(publicDir, distPublicDir);

  const files = await walkFiles(distPublicDir);
  await Promise.all(files.map((filePath) => precompressFile(filePath)));

  // eslint-disable-next-line no-console
  console.log(`Build estático gerado em: ${distPublicDir}`);
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Falha no build estático:', error);
  process.exitCode = 1;
});
