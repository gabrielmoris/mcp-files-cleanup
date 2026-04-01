import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";
import fs from "node:fs";
import crypto from "crypto";

const MAX_FILES_TO_PROCESS = 1000;
const MAX_EXECUTION_TIME_MS = 5000;
const MAX_DEPTH = 10;
const MAX_ITEMS_PER_DIR = 100;
const COMMON_FILE_EXTENSIONS = [
  "txt",
  "js",
  "html",
  "css",
  "json",
  "xml",
  "md",
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "svg",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "mp4",
  "avi",
  "mkv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
];

const SAFE_TO_DELETE_IF_EMPTY = [".next", "dist", "build", "coverage", "out", "tmp", "temp"];

const server = new McpServer({
  name: "files-cleanup",
  version: "1.1.1",
});

// Store file hashes to detect duplicates
const fileHashes: Map<string, string[]> = new Map();

// MCP server

server.tool(
  "find-useless-files",
  "Find useless files in a directory",
  {
    directory: z.string().describe("The directory to search"),
    maxDepth: z.number().default(5).describe("Maximum directory depth to search, max value is 10"),
    maxFiles: z.number().default(1000).describe("Maximum number of files to process"),
  },
  async ({ directory, maxDepth, maxFiles }) => {
    try {
      // Clear previous results
      fileHashes.clear();

      // Set limits
      const startTime = Date.now();
      let filesProcessed = 0;
      let totalSize = 0;

      const actualMaxDepth = Math.min(maxDepth, MAX_DEPTH);
      const actualMaxFiles = Math.min(maxFiles, MAX_FILES_TO_PROCESS);

      const result = await findUselessFiles(directory, 0, actualMaxDepth, startTime, actualMaxFiles, filesProcessed);
      const uselessFiles = result.items;
      totalSize = result.totalSize;

      const duplicates = findDuplicateFiles(COMMON_FILE_EXTENSIONS);
      if (uselessFiles.length === 0 && duplicates.length === 0) {
        return { content: [{ type: "text", text: `No useless files found in: ${directory}` }] };
      }

      return {
        content: [
          { type: "text", text: `Found ${uselessFiles.length} potentially useless files/directories in: ${directory}` },
          { type: "text", text: `💾 Total size: ${formatBytes(totalSize)}` },
          { type: "text", text: uselessFiles.join("\n") },
          { type: "text", text: `Found ${duplicates.length} duplicate files in: ${directory}` },
          { type: "text", text: duplicates.join("\n") },
        ],
      };
    } catch (error: unknown) {
      if (error instanceof Error) {
        return { content: [{ type: "text", text: `Error scanning directory: ${error.message}` }] };
      }
      return { content: [{ type: "text", text: String(error) }] };
    }
  },
);

// Functions. TODO: Separate this  in a new file

function isSafeToDelete(dirName: string): boolean {
  return SAFE_TO_DELETE_IF_EMPTY.includes(dirName);
}

function getDirectorySize(dirPath: string): number {
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function findDuplicateFiles(includeExtensions: string[] = COMMON_FILE_EXTENSIONS): string[] {
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

async function calculateFileHash(itemPath: string): Promise<string> {
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

async function findUselessFiles(
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

const transport = new StdioServerTransport();
await server.connect(transport);
