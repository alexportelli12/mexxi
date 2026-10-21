import { access, realpath } from "node:fs/promises";

export async function canonicalPath(value) {
  return realpath(value);
}

export async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
