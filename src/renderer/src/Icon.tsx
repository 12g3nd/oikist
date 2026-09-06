/**
 * The icon set.
 *
 * Drawn rather than borrowed from Unicode. `⛶`, `⬓` and `◫` were standing in for icons,
 * and a glyph pulled from whichever font happens to have it arrives at a different
 * weight, size and baseline than everything around it — which is a large part of what
 * makes an interface read as assembled rather than built.
 *
 * One stroke width, one grid, `currentColor` throughout, so an icon inherits whatever
 * colour its context already decided.
 */

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const
};

function Svg({ children, label }: { readonly children: React.ReactNode; readonly label?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden={label === undefined}
      {...(label === undefined ? {} : { role: "img", "aria-label": label })}
      {...STROKE}
    >
      {children}
    </svg>
  );
}

export function IconPlus(): React.JSX.Element {
  return (
    <Svg>
      <path d="M8 3.5v9M3.5 8h9" />
    </Svg>
  );
}

export function IconClose(): React.JSX.Element {
  return (
    <Svg>
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </Svg>
  );
}

/** A pane divided left/right — the shape the action produces. */
export function IconSplitRight(): React.JSX.Element {
  return (
    <Svg>
      <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.5" />
      <path d="M8 3.25v9.5" />
    </Svg>
  );
}

/** The same, divided top/bottom. */
export function IconSplitDown(): React.JSX.Element {
  return (
    <Svg>
      <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.5" />
      <path d="M2.25 8h11.5" />
    </Svg>
  );
}

/** Corners pushing outward: this pane takes the whole tab. */
export function IconMaximize(): React.JSX.Element {
  return (
    <Svg>
      <path d="M6.25 2.75H2.75v3.5M9.75 2.75h3.5v3.5M13.25 9.75v3.5h-3.5M2.75 9.75v3.5h3.5" />
    </Svg>
  );
}

/** Corners pulling inward: give the others their space back. */
export function IconRestore(): React.JSX.Element {
  return (
    <Svg>
      <path d="M2.75 6.25h3.5v-3.5M13.25 6.25h-3.5v-3.5M13.25 9.75h-3.5v3.5M2.75 9.75h3.5v3.5" />
    </Svg>
  );
}

export function IconFolder(): React.JSX.Element {
  return (
    <Svg>
      <path d="M2.25 12.25v-8a1 1 0 011-1h2.9l1.35 1.6h5.25a1 1 0 011 1v6.4a1 1 0 01-1 1h-9.5a1 1 0 01-1-1z" />
    </Svg>
  );
}

/** Two panes side by side, marking a tab that is split. */
export function IconPanes(): React.JSX.Element {
  return (
    <Svg>
      <rect x="2.25" y="3.75" width="4.75" height="8.5" rx="1" />
      <rect x="9" y="3.75" width="4.75" height="8.5" rx="1" />
    </Svg>
  );
}
