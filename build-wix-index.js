import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { createClient, ApiKeyStrategy } from "@wix/sdk";
import { folders, files } from "@wix/media";

dotenv.config();

const WIX_API_KEY = process.env.WIX_API_KEY;
const WIX_SITE_ID = process.env.WIX_SITE_ID;

if (!WIX_API_KEY || !WIX_SITE_ID) {
  console.error(
    "Error: WIX_API_KEY and WIX_SITE_ID must be set in your .env file.",
  );
  process.exit(1);
}

const wixClient = createClient({
  modules: { folders, files },
  auth: ApiKeyStrategy({
    apiKey: WIX_API_KEY,
    siteId: WIX_SITE_ID,
  }),
});

/**
 * Clean original filename to produce 1-2 word label and extract state code
 */
function parseFilename(originalName, folderStateCode = "") {
  // Remove file extension
  let base = originalName.replace(/\.[^/.]+$/, "");

  // Extract 2-letter state code if present (e.g., ML, AS, AR, MZ, MN, TR, NL)
  let state = folderStateCode;
  const stateMatch = base.match(/^(AS|ML|AR|MZ|MN|TR|NL)[_\-\s]/i);
  if (stateMatch) {
    state = stateMatch[1].toUpperCase();
    base = base.replace(/^(AS|ML|AR|MZ|MN|TR|NL)[_\-\s]/i, "");
  }

  // Remove trailing index numbers (e.g., _01, -2)
  base = base.replace(/[_\-\s]\d+$/, "");

  // Replace underscores and hyphens with spaces
  base = base.replace(/[_\-]/g, " ").trim();

  // Enforce maximum 2-word label constraint
  const words = base.split(/\s+/).filter(Boolean);
  const cleanLabel = words
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");

  return {
    label: cleanLabel || originalName,
    state: state || "ML", // Default to ML if state code missing
  };
}

/**
 * Helper to fetch all child folders for a given parent folder ID (with pagination)
 */
async function getChildFolders(parentFolderId) {
  let allFolders = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await wixClient.folders.listFolders({
      paging: { offset: page * 100, limit: 100 },
      parentFolderId: parentFolderId,
    });

    const folderList = response.folders || response.items || [];
    allFolders = allFolders.concat(folderList);

    hasMore = folderList.length === 100;
    page++;
  }

  return allFolders;
}

/**
 * Recursively fetch folder hierarchy starting from media-root
 * Returns a map of folderId -> { id, name, fullPath, stateCode, guestName }
 */
async function buildFolderTree() {
  const folderTreeMap = new Map();

  async function traverse(parentFolderId, currentPath) {
    const children = await getChildFolders(parentFolderId);

    for (const folder of children) {
      const folderId = folder._id || folder.id;
      const folderName = folder.displayName || folder.name;
      const fullPath = currentPath
        ? `${currentPath}/${folderName}`
        : folderName;

      // Extract state code if folder name matches state pattern (e.g., ML, AS, AR)
      let stateCode = "";
      const stateMatch = folderName.match(/^(AS|ML|AR|MZ|MN|TR|NL)$/i);
      if (stateMatch) {
        stateCode = stateMatch[1].toUpperCase();
      }

      // Check if folder is directly inside 'maps' to identify guest name
      let guestName = "";
      const pathSegments = fullPath.split("/");
      const mapsIdx = pathSegments.findIndex(
        (seg) => seg.toLowerCase() === "maps",
      );
      if (mapsIdx !== -1 && mapsIdx < pathSegments.length - 1) {
        guestName = pathSegments[mapsIdx + 1];
      }

      folderTreeMap.set(folderId, {
        id: folderId,
        name: folderName,
        fullPath: fullPath,
        stateCode: stateCode,
        guestName: guestName,
      });

      // Recurse into subfolders
      await traverse(folderId, fullPath);
    }
  }

  console.log("Starting folder tree traversal from media-root...");
  await traverse("media-root", "");

  return folderTreeMap;
}

/**
 * Helper to fetch all files in a specific folder ID (with pagination)
 */
async function getFilesInFolder(parentFolderId) {
  let allFiles = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await wixClient.files.listFiles({
      paging: { offset: page * 100, limit: 100 },
      parentFolderId: parentFolderId,
    });

    const fileList = response.files || response.items || [];
    allFiles = allFiles.concat(fileList);

    hasMore = fileList.length === 100;
    page++;
  }

  return allFiles;
}

/**
 * Main indexing execution
 */
async function buildWixIndex() {
  console.log("Fetching complete folder hierarchy starting from media-root...");
  const folderTreeMap = await buildFolderTree();

  console.log(`Discovered ${folderTreeMap.size} subfolders.`);

  const csvRows = [
    ["Category", "Image Label", "State", "Description", "Wix URL"],
  ];

  // Temporary storage to enforce one-cover-image-per-state constraint
  const coverImagesByState = new Map();

  let totalIndexedCount = 0;

  // Process files folder by folder
  for (const [folderId, folderInfo] of folderTreeMap.entries()) {
    const fullPath = folderInfo.fullPath.toLowerCase();

    // Determine category based on target path structures
    let category = null;
    if (
      fullPath.includes("cover-images") ||
      fullPath.includes("cover_images")
    ) {
      category = "Hero";
    } else if (fullPath.includes("maps")) {
      category = "Map";
    } else if (
      fullPath.includes("day-wise") ||
      fullPath.includes("day-wise-images")
    ) {
      category = "Day";
    }

    // Skip folders not matching target media paths
    if (!category) continue;

    console.log(
      `Fetching media files from folder: ${folderInfo.fullPath} (${folderId})...`,
    );
    const folderFiles = await getFilesInFolder(folderId);

    for (const file of folderFiles) {
      const fileName =
        file.displayName || file.fileName || file.originalFileName || "";
      if (!fileName) continue;

      // Construct public static Wix URL
      const wixUrl =
        file.url ||
        file.directUrl ||
        (file.hash
          ? `https://static.wixstatic.com/media/${file.hash}~mv2.${file.format || "jpg"}`
          : "");

      if (!wixUrl) continue;

      if (category === "Hero") {
        // Enforce 1 cover image per state protocol
        const state = folderInfo.stateCode || parseFilename(fileName).state;
        if (!coverImagesByState.has(state)) {
          coverImagesByState.set(state, []);
        }
        coverImagesByState.get(state).push({
          fileName,
          wixUrl,
          state,
        });
      } else if (category === "Map") {
        // Format Map Image Label: [Guest Full Name]-Option [Number]
        const guestName = folderInfo.guestName || folderInfo.name;
        const baseName = fileName.replace(/\.[^/.]+$/, "");

        let optionMatch = baseName.match(/option\s*(\d+)/i);
        let optionNum = optionMatch ? optionMatch[1] : "1";

        let label = `${guestName}-Option ${optionNum}`;
        let state = folderInfo.stateCode || "ML";

        csvRows.push([
          "Map",
          `"${label.replace(/"/g, '""')}"`,
          state,
          `"${label.replace(/"/g, '""')}"`,
          wixUrl,
        ]);
        totalIndexedCount++;
      } else if (category === "Day") {
        const { label, state } = parseFilename(fileName, folderInfo.stateCode);

        csvRows.push([
          "Day",
          `"${label.replace(/"/g, '""')}"`,
          state,
          `"${label.replace(/"/g, '""')}"`,
          wixUrl,
        ]);
        totalIndexedCount++;
      }
    }
  }

  // Process Hero (Cover Images): Select exactly 1 image randomly per state
  for (const [state, imageList] of coverImagesByState.entries()) {
    if (imageList.length === 0) continue;

    // Pick one randomly if multiple exist
    const selected = imageList[Math.floor(Math.random() * imageList.length)];
    const { label } = parseFilename(selected.fileName, state);

    csvRows.push([
      "Hero",
      `"${label.replace(/"/g, '""')}"`,
      state,
      `"${label.replace(/"/g, '""')}"`,
      selected.wixUrl,
    ]);
    totalIndexedCount++;
  }

  // Write to master-image-index.csv
  const csvContent = csvRows.map((row) => row.join(",")).join("\n");
  const outputPath = path.resolve(process.cwd(), "master-image-index.csv");
  fs.writeFileSync(outputPath, csvContent, "utf8");

  console.log(`\nSuccessfully generated image index at: ${outputPath}`);
  console.log(`Total indexed images in CSV: ${totalIndexedCount}`);
}

buildWixIndex().catch((err) => {
  console.error("Failed to build Wix index:", err);
  process.exit(1);
});
