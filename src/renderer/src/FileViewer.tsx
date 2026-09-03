import { useCallback, useEffect, useRef, useState } from "react";

import { breadcrumbs, formatSize, type FileContent, type FileEntry } from "../../shared/files.js";
import type { DirectoryListing } from "../../shared/ipc.js";

interface FileViewerProps {
  /** The directory being browsed. Persisted, so a pane reopens where it was. */
  readonly path?: string;
  readonly onPathChange: (path: string) => void;
}

function parentOf(path: string): string | null {
  const crumbs = breadcrumbs(path);
  return crumbs.length > 1 ? (crumbs[crumbs.length - 2]?.path ?? null) : null;
}

/**
 * A read-only file viewer.
 *
 * Read-only by decision rather than by omission — editing is on the v1 fence — so there
 * is deliberately no save, rename or delete anywhere in this component, and no channel
 * behind it that could perform one.
 */
export function FileViewer({ path, onPathChange }: FileViewerProps): React.JSX.Element {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Held in a ref for the same reason the terminal holds `onExit`: callers pass an
  // inline arrow, so as a dependency it would rebuild `browse` on every parent render,
  // re-run the effect, and clear the file being read. Reading a file would look like
  // nothing happening at all.
  const onPathChangeRef = useRef(onPathChange);
  onPathChangeRef.current = onPathChange;

  const browse = useCallback((next: string) => {
    setError(null);
    window.oikist.files
      .list(next)
      .then((result) => {
        setListing(result);
        setContent(null);
        onPathChangeRef.current(result.path);
      })
      .catch((cause: unknown) => setError(message(cause)));
  }, []);

  useEffect(() => {
    if (path !== undefined) {
      browse(path);
      return;
    }
    // No remembered directory: start somewhere that always exists.
    window.oikist.files.home().then(browse).catch((cause: unknown) => setError(message(cause)));
  }, [path, browse]);

  const open = (entry: FileEntry): void => {
    const target = `${listing?.path.replace(/\\+$/, "")}\\${entry.name}`;
    if (entry.kind === "directory") {
      browse(target);
      return;
    }
    setError(null);
    window.oikist.files
      .read(target)
      .then(setContent)
      .catch((cause: unknown) => {
        setContent(null);
        setError(message(cause));
      });
  };

  const parent = listing === null ? null : parentOf(listing.path);

  return (
    <div className="files">
      <div className="files-bar">
        <nav className="files-crumbs" aria-label="Path">
          {listing !== null &&
            breadcrumbs(listing.path).map((crumb) => (
              <button key={crumb.path} type="button" className="files-crumb" onClick={() => browse(crumb.path)}>
                {crumb.label}
              </button>
            ))}
        </nav>
        <button
          type="button"
          className="files-up"
          disabled={parent === null}
          onClick={() => parent !== null && browse(parent)}
          title="Parent directory"
        >
          ↑
        </button>
      </div>

      {error !== null && (
        <p className="files-error" role="alert">
          {error}
        </p>
      )}

      <div className="files-body">
        <ul className="files-list">
          {listing?.entries.map((entry) => (
            <li key={entry.name}>
              <button
                type="button"
                className={`files-entry files-entry--${entry.kind}${content?.path.endsWith(`\\${entry.name}`) === true ? " files-entry--open" : ""}`}
                onClick={() => open(entry)}
              >
                <span className="files-name">{entry.name}</span>
                <span className="files-size">
                  {entry.kind === "directory" ? "" : formatSize(entry.size ?? 0)}
                </span>
              </button>
            </li>
          ))}
          {listing?.truncated === true && <li className="files-note">…listing truncated</li>}
        </ul>

        <div className="files-content">
          {content === null ? (
            <p className="files-note">Select a file to read it. Nothing here can change it.</p>
          ) : (
            <>
              {content.truncated && (
                <p className="files-note">
                  Showing the first part of a {formatSize(content.bytes)} file.
                </p>
              )}
              <pre className="files-text">{content.text}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function message(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  // Electron prefixes rejections from a handler; the reason is the useful half.
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
}
