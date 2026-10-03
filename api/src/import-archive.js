import { unzipSync } from 'fflate';

// fflate calls this filter before allocating/decompressing each member.
export function readImportArchive(buffer) {
  let count = 0, total = 0;
  return unzipSync(buffer, { filter(entry) {
    count += 1;
    total += entry.originalSize;
    if (count > 300 || !Number.isSafeInteger(total) || total > 20 * 1024 * 1024 ||
        /vbaProject\.bin|activeX|externalLinks|embeddings/i.test(entry.name)) {
      throw Error('invalid_import_archive');
    }
    return true;
  } });
}
