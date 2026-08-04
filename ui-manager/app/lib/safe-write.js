const fs = require("fs");
const path = require("path");

function atomicWriteFile(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch { /* best-effort cleanup */ }
    throw error;
  }
  return filePath;
}

// Writes a JSON settings object atomically with a 0600 mode so a partial or
// interrupted write never leaves a corrupt or world-readable settings file.
function atomicWriteJson(filePath, value, mode = 0o600) {
  return atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

module.exports = { atomicWriteFile, atomicWriteJson };
