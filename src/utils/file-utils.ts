import { COMMON_FILE_EXTENSIONS, MAX_EXECUTION_TIME_MS, MAX_ITEMS_PER_DIR, SAFE_TO_DELETE_IF_EMPTY } from "./constants";
import fs from "node:fs";
import crypto from "crypto";
import path from "path";
import { formatBytes } from "./format-utils";
import { fileHashes } from "../main";

export async function calculateFileHash(itemPath: string): Promise<string> {
  const stats = fs.lstatSync(itemPath);
  if (!stats.isFile()) {
    return ""; // Return empty string for non-files.
  }

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const fileStream = fs.createReadStream(itemPath);

    fileStream.on("data", (chunk) => {
      hash.update(chunk);
    });

    fileStream.on("end", () => {
      resolve(hash.digest("hex"));
    });

    fileStream.on("error", (err) => {
      reject(err);
    });
  });
}

export function findDuplicateFiles(includeExtensions: string[] = COMMON_FILE_EXTENSIONS): string[] {
  const duplicates: string[] = [];

  fileHashes.forEach((filePaths) => {
    if (filePaths.length > 1) {
      const original = filePaths[0];
      const dupes = filePaths.slice(1);

      dupes.forEach((dupe) => {
        const originalExtension = path.extname(original).slice(1).toLowerCase();
        const dupeExtension = path.extname(dupe).slice(1).toLowerCase();

        // Check if extensions should be included
        if (includeExtensions.length === 0 || (includeExtensions.includes(originalExtension) && includeExtensions.includes(dupeExtension))) {
          duplicates.push(`${dupe} (duplicate of ${original})`);
        }
      });
    }
  });

  return duplicates;
}

export function isSafeToDelete(dirName: string): boolean {
  return SAFE_TO_DELETE_IF_EMPTY.includes(dirName);
}

export function getDirectorySize(dirPath: string): number {
  let size = 0;
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = fs.lstatSync(itemPath);
      if (stats.isDirectory()) {
        size += getDirectorySize(itemPath);
      } else {
        size += stats.size;
      }
    }
  } catch {
    // Error
    return -1;
  }
  return size;
}

export async function findUselessFiles(
  dirPath: string,
  currentDepth = 0,
  maxDepth = 5,
  startTime = Date.now(),
  maxFiles = 1000,
  filesProcessed = 0,
): Promise<{ items: string[]; totalSize: number }> {
  const uselessFiles: string[] = [];
  let totalSize = 0;

  if (dirPath.includes("node_modules") || dirPath.includes(".git")) {
    return { items: uselessFiles, totalSize };
  }

  // Check time limit
  if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
    uselessFiles.push(`${dirPath} (execution time limit reached)`);
    return { items: uselessFiles, totalSize };
  }

  // Check file count limit
  if (filesProcessed >= maxFiles) {
    uselessFiles.push(`${dirPath} (max files limit reached)`);
    return { items: uselessFiles, totalSize };
  }

  // Prevent excessive recursion
  if (currentDepth > maxDepth) {
    uselessFiles.push(`${dirPath} (max depth reached)`);
    return { items: uselessFiles, totalSize };
  }

  // Check if directory exists
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory does not exist: ${dirPath}`);
  }

  // Get all files and directories in the path
  let items: string[];
  try {
    items = fs.readdirSync(dirPath);
  } catch (error: unknown) {
    if (error instanceof Error) {
      return { items: [`${dirPath} (error: ${error.message})`], totalSize: 0 };
    }
    return { items: [`${dirPath} (error: ${String(error)})`], totalSize: 0 };
  }

  // Empty directory
  if (items.length === 0 && isSafeToDelete(path.basename(dirPath))) {
    uselessFiles.push(`${dirPath} (empty directory)`);
  }

  // Process only a limited number of items per directory
  const itemsToProcess = items.slice(0, MAX_ITEMS_PER_DIR);

  if (items.length > MAX_ITEMS_PER_DIR) {
    uselessFiles.push(`${dirPath} (limited scan: ${MAX_ITEMS_PER_DIR}/${items.length} items)`);
  }

  for (const item of itemsToProcess) {
    const itemPath = path.join(dirPath, item);

    try {
      filesProcessed++;
      const stats = fs.lstatSync(itemPath);

      if (stats.isDirectory()) {
        const dirName = path.basename(itemPath);

        if (isSafeToDelete(dirName)) {
          const dirSize = getDirectorySize(itemPath);
          totalSize += dirSize;
          uselessFiles.push(`${itemPath} (build artifact: ${formatBytes(dirSize)})`);
          continue;
        }

        const subDirResults = await findUselessFiles(itemPath, currentDepth + 1, maxDepth, startTime, maxFiles, filesProcessed);
        uselessFiles.push(...subDirResults.items);
        totalSize += subDirResults.totalSize;
      } else {
        if (stats.size === 0) {
          uselessFiles.push(`${itemPath} (empty file)`);
        }

        const fileExtension = path.extname(itemPath).slice(1).toLowerCase();
        if (COMMON_FILE_EXTENSIONS.includes(fileExtension)) {
          const fileHash = await calculateFileHash(itemPath);

          if (fileHash) {
            if (!fileHashes.has(fileHash)) {
              fileHashes.set(fileHash, [itemPath]);
            } else {
              fileHashes.get(fileHash)?.push(itemPath);
            }
          }
        }
      }

      // Check time limit again
      if (Date.now() - startTime > MAX_EXECUTION_TIME_MS) {
        uselessFiles.push(`${dirPath} (execution time limit reached during processing)`);
        break;
      }

      // Check file count limit again
      if (filesProcessed >= maxFiles) {
        uselessFiles.push(`${dirPath} (max files limit reached during processing)`);
        break;
      }
    } catch (error: unknown) {
      if (error instanceof Error) {
        uselessFiles.push(`${itemPath} (error: ${error.message})`);
      } else {
        uselessFiles.push(`${itemPath} (error: ${String(error)})`);
      }
    }
  }

  return { items: uselessFiles, totalSize };
}
