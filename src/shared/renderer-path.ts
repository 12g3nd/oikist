import { isAbsolute, join, normalize, relative } from "node:path";

/**
 * Resolves a request path from the `app://` scheme to a file inside the renderer
 * directory, or null if it would escape.
 *
 * Kept pure and separate from the protocol handler so the escape rule is testable
 * without an Electron runtime. `normalize` alone is not the check: the resolved path is
 * compared back against the root, because normalisation handles `..` but says nothing
 * about absolute paths, drive-relative paths, or encoded separators that survive it.
 */
export function resolveRendererPath(rendererDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed percent-escape is not a path this server should guess at.
    return null;
  }

  // A NUL byte can truncate a path inside a native call, so it is refused outright
  // rather than normalised away.
  if (decoded.includes("\0")) {
    return null;
  }

  const requested = decoded === "" || decoded === "/" ? "/index.html" : decoded;
  const candidate = normalize(join(rendererDir, requested));
  const escape = relative(rendererDir, candidate);

  if (escape.startsWith("..") || isAbsolute(escape)) {
    return null;
  }
  return candidate;
}
